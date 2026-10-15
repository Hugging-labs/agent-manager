#!/bin/sh
# Durable state bridge for the agent harnesses.
#
# Active state always lives on the container's POSIX filesystem. The mounted
# bucket only receives short-lived, closed writes made by rsync (ordinary file
# trees) or SQLite's online backup API (live databases). This is intentional:
# hf-mount's streaming writer holds an open file in memory until close, while
# copying a database and its WAL independently can produce a torn backup.
#
# Restore speed. The bucket costs ~27 ms per file, read or stat, so a restore is
# bound by file COUNT, not bytes — and one sequential rsync per harness kept a
# Space silent for 25 minutes at boot. Three things keep it short: what is not
# worth restoring is excluded (and pruned from the bucket once); the adapters
# restore concurrently; and the big trees are split by subdirectory into a
# bounded pool of rsyncs, each applying exactly the filters a single rsync
# would. The restore reports progress on stdout as it goes.

set -u

MODE="${1:-}"
case "$MODE" in
  restore|checkpoint|checkpoint-final|prune|stop-prune|_part|_adapter) ;;
  *) echo "usage: $0 restore|checkpoint|checkpoint-final|prune|stop-prune" >&2; exit 2 ;;
esac
SELF="$0"

: "${DATA_DIR:?DATA_DIR is required}"
: "${AM_LOCAL:?AM_LOCAL is required}"

CODEX_HOME="${CODEX_HOME:-$AM_LOCAL/codex-home}"
CODEX_DURABLE="${CODEX_DURABLE:-$DATA_DIR/state/codex}"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$AM_LOCAL/agent-state/claude}"
CLAUDE_DURABLE="${CLAUDE_DURABLE:-$DATA_DIR/state/claude}"
GEMINI_CLI_HOME="${GEMINI_CLI_HOME:-$AM_LOCAL/agent-state/gemini-home}"
GEMINI_LIVE="${GEMINI_LIVE:-$GEMINI_CLI_HOME/.gemini}"
GEMINI_DURABLE="${GEMINI_DURABLE:-$DATA_DIR/state/gemini}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$AM_LOCAL/oc-home/.openclaw}"
OPENCLAW_DURABLE="${OPENCLAW_DURABLE:-$DATA_DIR/state/openclaw-backup}"
OPENCODE_LIVE="${OPENCODE_LIVE:-$AM_LOCAL/opencode-share}"
OPENCODE_DURABLE="${OPENCODE_DURABLE:-$DATA_DIR/state/opencode}"
HERMES_LIVE="${HERMES_LIVE:-$AM_LOCAL/hermes}"
HERMES_DURABLE="${HERMES_DURABLE:-$DATA_DIR/state/hermes}"
# fx keeps its coordination files beside the transcripts it must never lose.
# session.lock / commit.lock / subagent/*.lock name a live process, so a
# restored one is a lock nobody holds; index.pending is a half-written index fx
# rebuilds. Everything else under ~/.fx — auth, settings.json, mcp.json,
# memories.json, sessions/*/events.jsonl — has to come back after a restart.
# Both directions carry the excludes, so an older durable tree written before
# they existed cannot hand a stale lock back on restore.
FX_LIVE="${FX_LIVE:-$AM_LOCAL/fx-home}"
FX_DURABLE="${FX_DURABLE:-$DATA_DIR/state/fx}"

# rsyncs one big tree may run at once. Claude and Codex each get a pool, the
# five small adapters one rsync each: at most 2×JOBS+5 concurrent at boot.
JOBS="${AGENT_STATE_JOBS:-8}"
HEARTBEAT="${AGENT_STATE_HEARTBEAT:-30}"
# Claude writes a `.claude.json.backup.<ms>` on every config save and keeps the
# last five itself. Checkpoints never delete, so the bucket kept every one ever
# made (2,065, 250 MB, measured). Only the newest few come back.
KEEP_CLAUDE_BACKUPS="${AGENT_STATE_KEEP_CLAUDE_BACKUPS:-5}"
# The most junk files one prune removes; the rest goes on the next boot.
PRUNE_MAX="${AGENT_STATE_PRUNE_MAX:-50000}"
# Diagnostic: `restore` with this set only lists what the tree rsyncs would
# copy (`rsync -n`) and writes nothing — no stamps, no databases.
DRY_RUN="${AGENT_STATE_DRY_RUN:-}"

LOCK="$AM_LOCAL/agent-state-checkpoint.lock"
mkdir -p "$AM_LOCAL"
if [ "$MODE" = stop-prune ]; then
  # The entrypoint, at shutdown: stop a running prune's whole process group
  # (it was started under setsid) and return once it is gone, so the final
  # checkpoint neither races it nor waits on it.
  _pf="$AM_LOCAL/agent-state-prune.pgid"
  _g=$(cat "$_pf" 2>/dev/null) || exit 0
  [ -n "$_g" ] || exit 0
  kill -TERM "-$_g" 2>/dev/null || { rm -f "$_pf"; exit 0; }
  _i=0
  while kill -0 "-$_g" 2>/dev/null && [ "$_i" -lt 50 ]; do sleep 0.1; _i=$((_i + 1)); done
  kill -KILL "-$_g" 2>/dev/null
  rm -f "$_pf"
  echo "agent-state: stopped the junk prune for shutdown"
  exit 0
elif [ "$MODE" = _part ] || [ "$MODE" = _adapter ]; then
  # Part of a parallel restore, started by the restore holding the lock.
  :
elif [ "$MODE" = prune ]; then
  # One prune at a time. It also takes the CHECKPOINT lock, a batch at a time
  # (see the prune below): a checkpoint that published a new Claude backup
  # between the prune listing the backups and deleting them would otherwise
  # lose it.
  exec 8>"$AM_LOCAL/agent-state-prune.lock"
  flock -n 8 || exit 0
  exec 9>"$LOCK"
else
  exec 9>"$LOCK"
  if [ "$MODE" = restore ] || [ "$MODE" = checkpoint-final ]; then
    # A dev-mode restart may overlap the previous app's final checkpoint. Never
    # restore an older durable view while that checkpoint is still being made.
    flock 9
  else
    # Timer and shutdown checkpoints can race; the one already holding the lock
    # is sufficient, and a later timer/shutdown will catch subsequent writes.
    flock -n 9 || exit 0
  fi
fi

log() { echo "${AGENT_STATE_LOG_PREFIX:-}agent-state: $*"; }
now() { date +%s; }
elapsed() {
  _s=$(( $(now) - $1 ))
  if [ "$_s" -ge 60 ]; then printf '%dm%02ds' $((_s / 60)) $((_s % 60)); else printf '%ds' "$_s"; fi
}
count_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
tree_size() { du -sh "$1" 2>/dev/null | cut -f1; }
# A name as a literal rsync pattern: [ ] * ? and \ would otherwise be wildcards.
literal() { printf '%s' "$1" | sed 's/[][*?\\]/\\&/g'; }

# `find -newer` is a strict comparison. A file written in the same filesystem
# timestamp tick as a checkpoint marker would otherwise be skipped forever.
# Keep a small overlap at every successful boundary; an occasional repeat copy
# is harmless, while a missed transcript/config is not.
mark_checkpoint_floor() {
  touch -d '2 seconds ago' "$1" 2>/dev/null || touch "$1"
}

# rsync exit 24 is "partial transfer due to vanished source files": between
# building its file list and reading them, something deleted files the listing
# still named. Both tree copies are exposed to it — a restore walks the bucket
# for minutes while a harness prunes transcript scratch, and a checkpoint copies
# a live tree the harnesses are still writing. What vanishes is the scratch
# itself, so nothing durable is lost and the copy is otherwise complete.
# Treating it as a failure once refused to boot the Space at all.
# Single-file copies below keep the strict test: there, a vanished source is
# exactly the file we were asked for.
rsync_tree() {
  rsync "$@"; _rs_rc=$?
  [ "$_rs_rc" -eq 24 ] && _rs_rc=0
  return "$_rs_rc"
}

# Each adapter's filters, in ONE place, for both directions and for every slice
# of a parallel restore. Checkpoints enumerate files explicitly via
# --files-from, and excluding just a directory name does not exclude its
# explicitly listed descendants: subtree patterns (`**/x/***`, or `/x/***` for
# the top level only) cover both the directory and everything under it.
#
#   codex  tmp/ holds one `arg0/codex-arg0XXXXXX/.lock` per process that ever
#          ran (1,888 in the bucket, 9 live); plugins/ held only cache/ — the
#          curated plugins Codex downloads again — and its install staging.
#   claude backups/ come back as the newest few only (restore_claude_backups).
#          file-history/ is kept: it is what /rewind restores edited files from,
#          for resumed conversations too.
rsync_adapter() {
  _dir="$1" _key="$2"; shift 2
  case "$_key" in
    codex)
      rsync_tree --exclude '*.sqlite*' --exclude '*.db' --exclude '*.db-*' \
        --exclude '*-wal' --exclude '*-shm' --exclude '**/db-backups/***' \
        --exclude '**/cache/***' --exclude '**/.tmp/***' --exclude '**/mcp-oauth-locks/***' \
        --exclude '/tmp/***' --exclude '/plugins/.remote-plugin-install-staging/***' "$@" ;;
    claude)
      if [ "$_dir" = restore ]; then rsync_tree --exclude '/backups/***' "$@"; else rsync_tree "$@"; fi ;;
    fx)
      rsync_tree --exclude '*.lock' --exclude 'index.pending' "$@" ;;
    *-files)
      rsync_tree --exclude 'checkpoints' --exclude '*.db' --exclude '*.db-*' \
        --exclude '*.sqlite*' --exclude '*-wal' --exclude '*-shm' "$@" ;;
    *)
      rsync_tree "$@" ;;
  esac
}

restore_flags() {
  if [ -n "$DRY_RUN" ]; then echo '-a --update -n --out-format=%n'; else echo '-a --update'; fi
}

# One slice of a tree: the same transfer root and the same adapter filters as a
# whole-tree rsync, narrowed by include/exclude rules to one part of it. rsync
# never descends an excluded directory, so a slice walks only its own part.
#   all      the whole tree (no pool)
#   files:   the top-level files
#   files:D  the files directly in D
#   tree:D   all of D
#   tree:D/C all of D/C
restore_slice() {
  _key="$1" _durable="$2" _live="$3" _spec="$4"
  # shellcheck disable=SC2046  # restore_flags is a fixed list of flags
  set -- $(restore_flags)
  case "$_spec" in
    all) rsync_adapter restore "$_key" "$@" "$_durable/" "$_live/" ;;
    files:) rsync_adapter restore "$_key" --exclude '/*/' "$@" "$_durable/" "$_live/" ;;
    files:*)
      _d=$(literal "${_spec#files:}")
      rsync_adapter restore "$_key" --include "/$_d/" --exclude "/$_d/*/" --include "/$_d/*" --exclude '/*' \
        "$@" "$_durable/" "$_live/" ;;
    tree:*/*)
      _p="${_spec#tree:}"; _a=$(literal "${_p%%/*}"); _b=$(literal "${_p#*/}")
      rsync_adapter restore "$_key" --include "/$_a/" --include "/$_a/$_b/***" --exclude "/$_a/*" --exclude '/*' \
        "$@" "$_durable/" "$_live/" ;;
    tree:*)
      _d=$(literal "${_spec#tree:}")
      rsync_adapter restore "$_key" --include "/$_d/***" --exclude '/*' "$@" "$_durable/" "$_live/" ;;
    *) echo "agent-state: unknown restore slice '$_spec'" >&2; return 2 ;;
  esac
}

# The slices of a durable tree, NUL-separated: its top-level files, each
# top-level directory, and — for the directories named in $2 — each of their
# subdirectories instead. Listing reads directories only (no stat of their
# contents); symlinks are never followed into.
list_slices() {
  _root="$1" _split="$2"
  printf 'files:\0'
  for _e in "$_root"/* "$_root"/.[!.]* "$_root"/..?*; do
    [ -d "$_e" ] && [ ! -L "$_e" ] || continue
    _n="${_e##*/}"
    case " $_split " in
      *" $_n "*)
        printf 'files:%s\0' "$_n"
        for _c in "$_e"/* "$_e"/.[!.]* "$_e"/..?*; do
          [ -d "$_c" ] && [ ! -L "$_c" ] || continue
          printf 'tree:%s/%s\0' "$_n" "${_c##*/}"
        done ;;
      *) printf 'tree:%s\0' "$_n" ;;
    esac
  done
}

# Every slice of a tree through a pool of at most $JOBS rsyncs. Any failed
# slice fails the tree (xargs exits non-zero when any command did).
parallel_restore() {
  _key="$1" _durable="$2" _live="$3" _split="$4"
  if [ "$JOBS" -le 1 ]; then
    restore_slice "$_key" "$_durable" "$_live" all
    return
  fi
  list_slices "$_durable" "$_split" | xargs -0 -r -n 1 -P "$JOBS" sh "$SELF" _part "$_key" "$_durable" "$_live"
}

restore_tree() {
  key="$1" durable="$2" live="$3" split="${4:-}"
  mkdir -p "$durable" "$live"
  stamp_dir="$AM_LOCAL/agent-state-stamps"
  stamp="$stamp_dir/$key"
  had_local=false
  [ -n "$(find "$live" -type f -print -quit 2>/dev/null)" ] && had_local=true
  # --update matters for hot/dev restarts: local disk survives those and can be
  # newer than the last completed bucket checkpoint. A fresh container starts
  # with an empty destination, so the same command performs a full restore.
  if parallel_restore "$key" "$durable" "$live" "$split"; then
    [ -n "$DRY_RUN" ] && return 0
    mkdir -p "$stamp_dir"
    if [ ! -e "$stamp" ]; then
      if [ "$had_local" = true ]; then
        # First deployment over an already-populated local tree: force one
        # checkpoint so newer local files skipped by --update become durable.
        touch -t 197001010000 "$stamp"
      else
        # Fresh container: every local byte came from this durable restore.
        mark_checkpoint_floor "$stamp"
      fi
    fi
  else
    return 1
  fi
}

checkpoint_tree() {
  key="$1" live="$2" durable="$3"
  [ -d "$live" ] || return 0
  stamp_dir="$AM_LOCAL/agent-state-stamps"
  mkdir -p "$durable" "$stamp_dir"
  stamp="$stamp_dir/$key"
  if [ ! -e "$stamp" ]; then
    touch -t 197001010000 "$stamp"
  fi

  # Mark the START of this checkpoint. Any file changed during/after its copy
  # is newer than `next` and will therefore be selected again next time.
  next="$stamp.next.$$"
  list="$stamp.files.$$"
  mark_checkpoint_floor "$next"
  (cd "$live" && find . -type f -newer "$stamp" -print0) > "$list"

  if [ -s "$list" ]; then
    # --files-from means rsync walks only changed LOCAL paths. It does not scan
    # the remote tree every 15 seconds — a critical property on the bucket
    # mount. Destination temporaries close before rename, retaining the prior
    # object if this process dies during transfer.
    if ! rsync_adapter checkpoint "$key" -a -r --from0 --files-from="$list" --delay-updates \
      "$live/" "$durable/"; then
      rm -f "$next" "$list"
      return 1
    fi
  fi
  mv "$next" "$stamp"
  rm -f "$list"
}

# The newest few Claude config backups, by the millisecond stamp in their
# names — read from the directory listing alone, without a stat per file.
newest_claude_backups() {
  ls -A "$1" 2>/dev/null | grep -E '^\.claude\.json\.backup\.[0-9]+$' | sort -t . -k 5,5n | tail -n "$2"
}

restore_claude_backups() {
  _src="$CLAUDE_DURABLE/backups" _dst="$CLAUDE_CONFIG_DIR/backups"
  [ -d "$_src" ] && [ ! -L "$_src" ] || return 0
  _list="$AM_LOCAL/agent-state-claude-backups.$$"
  newest_claude_backups "$_src" "$KEEP_CLAUDE_BACKUPS" > "$_list"
  if [ -s "$_list" ] && [ -z "$DRY_RUN" ]; then
    mkdir -p "$_dst"
    if ! rsync -a --update --files-from="$_list" "$_src/" "$_dst/"; then rm -f "$_list"; return 1; fi
  elif [ -n "$DRY_RUN" ]; then
    cat "$_list"
  fi
  rm -f "$_list"
}

restore_sqlite_tree() {
  durable="$1" live="$2" db_name="$3" checkpoint_name="$4"
  mkdir -p "$durable" "$live"

  if ! restore_tree "$checkpoint_name-files" "$durable" "$live"; then
    return 1
  fi
  [ -n "$DRY_RUN" ] && return 0

  checkpoint="$durable/checkpoints/$checkpoint_name"
  target="$live/$db_name"
  if [ -s "$target" ] && [ "$(sqlite3 "$target" 'PRAGMA quick_check;' 2>/dev/null)" = ok ]; then
    # Local disk survives in-container/dev restarts. Its database can be newer
    # than the last checkpoint (including committed rows still in its WAL), so
    # a valid live database is always the restore authority on a hot restart.
    return 0
  fi

  # Retain an invalid local set for diagnosis, then recover from the last
  # known-good checkpoint. These are explicit ephemeral paths, never bucket
  # objects.
  had_invalid=false
  if [ -e "$target" ] || [ -e "$target-wal" ] || [ -e "$target-shm" ]; then
    had_invalid=true
    invalid_dir="$AM_LOCAL/agent-state-invalid/$checkpoint_name.$(date -u +%Y%m%dT%H%M%SZ).$$"
    mkdir -p "$invalid_dir"
    [ -e "$target" ] && mv "$target" "$invalid_dir/$db_name"
    [ -e "$target-wal" ] && mv "$target-wal" "$invalid_dir/$db_name-wal"
    [ -e "$target-shm" ] && mv "$target-shm" "$invalid_dir/$db_name-shm"
  fi

  if [ -s "$checkpoint" ]; then
    # WAL/SHM are ephemeral coordination files, never part of a restored
    # checkpoint. Removing these explicit local paths cannot touch bucket data.
    rm -f "$target-wal" "$target-shm"
    if ! rsync -a "$checkpoint" "$target"; then return 1; fi
  elif [ -s "$durable/$db_name" ]; then
    # One-release compatibility path for state written by the old raw-rsync
    # mechanism. Copy the legacy DB and any WAL so SQLite can recover it; the
    # first successful checkpoint replaces this path as the restore authority.
    if ! rsync -a "$durable/$db_name" "$target"; then return 1; fi
    if [ -f "$durable/$db_name-wal" ] && ! rsync -a "$durable/$db_name-wal" "$target-wal"; then return 1; fi
    if [ -f "$durable/$db_name-shm" ] && ! rsync -a "$durable/$db_name-shm" "$target-shm"; then return 1; fi
  fi

  if [ "$had_invalid" = true ] && [ ! -s "$target" ]; then
    echo "agent-state: invalid local SQLite state has no durable recovery for $target" >&2
    return 1
  fi
  if [ -s "$target" ] && [ "$(sqlite3 "$target" 'PRAGMA quick_check;' 2>/dev/null)" != ok ]; then
    echo "agent-state: restored SQLite state is invalid for $target" >&2
    return 1
  fi
}

checkpoint_sqlite_tree() {
  live="$1" durable="$2" db_name="$3" checkpoint_name="$4"
  source="$live/$db_name"

  # A harness can write ordinary state before it creates its database (Hermes
  # setup files are a real example). Always publish that file tree first. The
  # database backup is optional until the database itself exists.
  if ! checkpoint_tree "$checkpoint_name-files" "$live" "$durable"; then
    return 1
  fi
  [ -s "$source" ] || return 0

  sqlite_stamp_dir="$AM_LOCAL/agent-state-stamps"
  sqlite_stamp="$sqlite_stamp_dir/$checkpoint_name-sqlite"
  mkdir -p "$sqlite_stamp_dir"
  # Timestamp-only detection has an equal-tick hole, while deliberately
  # overlapping the marker would rewrite an idle database on rapid successive
  # checkpoints. Record the exact local DB/WAL metadata observed BEFORE the
  # backup instead. A concurrent commit changes the next signature and is
  # therefore picked up by the following checkpoint.
  sqlite_next="$sqlite_stamp.next.$$"
  {
    stat -c 'db|%s|%y|%z' "$source"
    if [ -e "$source-wal" ]; then
      stat -c 'wal|%s|%y|%z' "$source-wal"
    else
      echo 'wal|absent'
    fi
  } > "$sqlite_next"
  if cmp -s "$sqlite_next" "$sqlite_stamp"; then
    rm -f "$sqlite_next"
    return 0
  fi

  stage_dir="$AM_LOCAL/agent-state-snapshots"
  mkdir -p "$stage_dir" "$durable/checkpoints"
  staged="$stage_dir/$checkpoint_name.$$.tmp"
  rm -f "$staged"
  escaped=$(printf '%s' "$staged" | sed "s/'/''/g")

  # .backup observes the main DB and WAL through one consistent SQLite read
  # transaction. The staged file is ordinary local storage and is closed before
  # rsync hands it to the bucket.
  if ! sqlite3 "$source" ".timeout 5000" ".backup '$escaped'"; then
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  if [ "$(sqlite3 "$staged" 'PRAGMA quick_check;' 2>/dev/null)" != ok ]; then
    echo "agent-state: refusing invalid SQLite checkpoint for $source" >&2
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  if ! rsync -a --delay-updates "$staged" "$durable/checkpoints/$checkpoint_name"; then
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  rm -f "$staged"
  mv "$sqlite_next" "$sqlite_stamp"
}

# ---------- restore: every adapter at once, with progress ----------

restore_codex() { restore_tree codex "$CODEX_DURABLE" "$CODEX_HOME"; }
# projects/ is most of Claude's bytes in one directory: one slice per project.
restore_claude() {
  restore_tree claude "$CLAUDE_DURABLE" "$CLAUDE_CONFIG_DIR" "projects file-history" && restore_claude_backups
}
restore_gemini() { restore_tree gemini "$GEMINI_DURABLE" "$GEMINI_LIVE"; }
restore_openclaw() { restore_tree openclaw "$OPENCLAW_DURABLE" "$OPENCLAW_STATE_DIR"; }
restore_opencode() { restore_sqlite_tree "$OPENCODE_DURABLE" "$OPENCODE_LIVE" opencode.db opencode.db; }
restore_hermes() { restore_sqlite_tree "$HERMES_DURABLE" "$HERMES_LIVE" state.db state.db; }
restore_fx() { restore_tree fx "$FX_DURABLE" "$FX_LIVE"; }

ADAPTERS="codex claude gemini openclaw opencode hermes fx"
live_of() {
  case "$1" in
    codex) echo "$CODEX_HOME" ;; claude) echo "$CLAUDE_CONFIG_DIR" ;; gemini) echo "$GEMINI_LIVE" ;;
    openclaw) echo "$OPENCLAW_STATE_DIR" ;; opencode) echo "$OPENCODE_LIVE" ;; hermes) echo "$HERMES_LIVE" ;;
    fx) echo "$FX_LIVE" ;;
  esac
}

# One adapter, start to finish, with its own progress lines. In a dry run its
# stdout is the list of paths that would be restored.
run_adapter() {
  _name="$1" _t0=$(now)
  if [ -n "$DRY_RUN" ]; then
    "restore_$_name" > "$WORK/$_name.list"; _rc=$?
    log "$_name: $(grep -cv '/$' "$WORK/$_name.list") files would be restored ($(elapsed "$_t0"))"
    : > "$WORK/done.$_name"
    return "$_rc"
  fi
  log "restoring $_name…"
  if "restore_$_name"; then
    _live=$(live_of "$_name")
    log "$_name done: $(count_files "$_live") files, $(tree_size "$_live") in $(elapsed "$_t0")"
    : > "$WORK/done.$_name"
  else
    log "$_name FAILED after $(elapsed "$_t0")" >&2
    : > "$WORK/failed.$_name"
    return 1
  fi
}

# Every $HEARTBEAT seconds, the files already on the LOCAL side of each adapter
# still restoring — counting there costs nothing, unlike walking the bucket.
heartbeat() {
  _parent="$1" _t0="$2" _sp=""
  # Killed, take the pending sleep with it: a sleep left behind keeps the
  # restore's stdout open, and whoever reads that output waits on it.
  trap 'kill $_sp 2>/dev/null; exit 0' TERM INT HUP
  while :; do
    sleep "$HEARTBEAT" & _sp=$!
    wait "$_sp"
    kill -0 "$_parent" 2>/dev/null || exit 0
    _line=""
    for _a in $ADAPTERS; do
      [ -e "$WORK/done.$_a" ] || [ -e "$WORK/failed.$_a" ] && continue
      _line="$_line, $_a $(count_files "$(live_of "$_a")") files"
    done
    [ -n "$_line" ] && log "still restoring after $(elapsed "$_t0"): ${_line#, } on local disk so far"
  done
}

failures=0

if [ "$MODE" = _part ]; then
  restore_slice "$2" "$3" "$4" "$5"
  exit $?
fi

if [ "$MODE" = _adapter ]; then
  # One adapter in its own process group (the restore starts it under setsid),
  # so an interrupted restore can stop it and every xargs, slice and rsync
  # under it in one kill — not just this shell.
  WORK="$2"
  echo "$$" > "$WORK/pgid.$3"
  run_adapter "$3"
  exit $?
fi

if [ "$MODE" = prune ]; then
  # Junk the excludes above keep out of every restore and checkpoint, but that
  # an older version had already written to the bucket — 10k+ files of it,
  # paid for at every boot. Deletes exactly these paths and nothing else:
  # only under the durable roots, never through a symlink (find does not
  # follow them; rm removes a link, not its target), at most $PRUNE_MAX files.
  WORK=$(mktemp -d "$AM_LOCAL/agent-state-prune.XXXXXX")
  # The entrypoint starts the prune as a process-group leader and stops that
  # group at shutdown; this is how it finds it.
  echo "$$" > "$AM_LOCAL/agent-state-prune.pgid"
  trap 'rm -rf "$WORK" "$AM_LOCAL/agent-state-prune.pgid"' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  budget="$PRUNE_MAX" total=0 t0=$(now)
  # Deletion happens under the checkpoint lock, PRUNE_BATCH files at a time,
  # so a timer checkpoint skips at most one batch and a final one waits for
  # at most one batch.
  PRUNE_BATCH="${AGENT_STATE_PRUNE_BATCH:-2000}"
  rm_locked() {
    split -t '\0' -l "$PRUNE_BATCH" "$1" "$WORK/batch."
    for _b in "$WORK"/batch.*; do
      [ -e "$_b" ] || continue
      flock 9
      xargs -0 -r -n 64 -P 16 rm -f -- < "$_b"
      flock -u 9
      rm -f "$_b"
    done
  }
  prune_subtree() {
    _root="$1"
    [ -e "$_root" ] || [ -L "$_root" ] || return 0
    if [ -L "$_root" ]; then log "prune: left ${_root#"$DATA_DIR"/} alone (a symlink)"; return 0; fi
    [ -d "$_root" ] && [ "$budget" -gt 0 ] || return 0
    find "$_root" \( -type f -o -type l \) -print0 | head -z -n "$budget" > "$WORK/list"
    _n=$(tr -cd '\0' < "$WORK/list" | wc -c | tr -d ' ')
    [ "$_n" -gt 0 ] && rm_locked "$WORK/list"
    find "$_root" -depth -type d -empty -delete 2>/dev/null
    budget=$((budget - _n)); total=$((total + _n))
    [ "$_n" -gt 0 ] && log "prune: ${_root#"$DATA_DIR"/}: removed $_n files"
  }
  for rel in .tmp tmp cache mcp-oauth-locks plugins/cache plugins/.remote-plugin-install-staging; do
    prune_subtree "$CODEX_DURABLE/$rel"
  done
  # Claude config backups beyond the newest few. What to keep and what to
  # delete come from ONE listing, read and acted on while holding the
  # checkpoint lock, so a backup a checkpoint publishes is either in that
  # listing (and ranked) or arrives after the prune has let go.
  _bk="$CLAUDE_DURABLE/backups"
  if [ -d "$_bk" ] && [ ! -L "$_bk" ] && [ "$budget" -gt 0 ]; then
    flock 9
    ls -A "$_bk" | grep -E '^\.claude\.json\.backup\.[0-9]+$' | sort -t . -k 5,5n > "$WORK/backups"
    _all=$(wc -l < "$WORK/backups" | tr -d ' ')
    _drop=$((_all - KEEP_CLAUDE_BACKUPS))
    [ "$_drop" -gt "$budget" ] && _drop="$budget"
    n=0
    if [ "$_drop" -gt 0 ]; then
      head -n "$_drop" "$WORK/backups" | sed "s|^|$_bk/|" | tr '\n' '\0' > "$WORK/list"
      xargs -0 -r -n 64 -P 16 rm -f -- < "$WORK/list"
      n="$_drop"
    fi
    flock -u 9
    [ "$n" -gt 0 ] && log "prune: ${CLAUDE_DURABLE#"$DATA_DIR"/}/backups: removed $n old config backups, kept the newest $KEEP_CLAUDE_BACKUPS"
    total=$((total + n)); budget=$((budget - n))
  fi
  if [ "$total" -gt 0 ]; then
    log "prune: removed $total junk files from the durable state in $(elapsed "$t0")"
    [ "$budget" -le 0 ] && log "prune: stopped at $PRUNE_MAX files; the rest goes on the next boot"
  fi
  exit 0
fi

# Files some process holds open under the live roots. A restore replaces files
# by rename, so a process holding one keeps writing to an unlinked inode while
# the path holds the older copy — and that inode is never checkpointed. This
# happened (2026-10-15): a restore run from a shell inside a running Space
# (whose environment exports these very paths) orphaned six open Codex
# rollouts. At boot no agent runs yet, so the check costs nothing there.
open_in_live_roots() {
  ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v roots="$CODEX_HOME|$CLAUDE_CONFIG_DIR|$GEMINI_LIVE|$OPENCLAW_STATE_DIR|$OPENCODE_LIVE|$HERMES_LIVE|$FX_LIVE" '
    BEGIN { n = split(roots, r, "|") }
    /^\/proc\/[0-9]+\/fd:$/ { pid = $0; sub(/^\/proc\//, "", pid); sub(/\/fd:$/, "", pid); next }
    / -> / { t = $0; sub(/^.* -> /, "", t)
      for (i = 1; i <= n; i++) if (r[i] != "" && index(t, r[i] "/") == 1) { print "pid " pid ": " t; break } }
  ' | head -n 20
}

if [ "$MODE" = restore ] && [ -z "$DRY_RUN" ]; then
  if [ -z "${AGENT_STATE_FROM_ENTRYPOINT:-}" ]; then
    log "WARNING: restore was not started by the entrypoint. It writes into $CODEX_HOME, $CLAUDE_CONFIG_DIR and the other live trees named by this environment."
  fi
  _open=$(open_in_live_roots)
  if [ -n "$_open" ] && [ -n "${AGENT_STATE_FROM_ENTRYPOINT:-}" ]; then
    # At boot nothing should hold these; if a restart ever left agents
    # running, refusing here would refuse to boot the Space at all. Say so
    # loudly and carry on, as the restore always has.
    echo "agent-state: WARNING: processes still have files open in the live trees; a file the restore replaces is left unlinked under them:" >&2
    echo "$_open" | sed 's/^/  /' >&2
  elif [ -n "$_open" ]; then
    echo "agent-state: refusing to restore: processes have files open in the live trees it would replace:" >&2
    echo "$_open" | sed 's/^/  /' >&2
    echo "agent-state: stop them first, or point every *_LIVE / *_HOME / *_DIR variable at a scratch tree." >&2
    exit 1
  fi
fi

if [ "$MODE" = restore ]; then
  WORK=$(mktemp -d "$AM_LOCAL/agent-state-restore.XXXXXX")
  t0=$(now)
  pids=""
  heartbeat $$ "$t0" &
  hb=$!
  # Interrupted, stop every adapter's whole process group — its xargs, slice
  # shells, rsyncs and sleeps — and reap them before reporting failure:
  # otherwise they go on changing the live trees after the restore has said
  # it failed. TERM first, KILL after five seconds.
  stop_workers() {
    trap '' INT TERM HUP
    _groups=""
    for _f in "$WORK"/pgid.*; do [ -e "$_f" ] && _groups="$_groups $(cat "$_f")"; done
    for _g in $_groups; do kill -TERM "-$_g" 2>/dev/null; done
    kill -TERM $pids 2>/dev/null
    _i=0
    while [ "$_i" -lt 50 ]; do
      _alive=0
      for _g in $_groups; do kill -0 "-$_g" 2>/dev/null && _alive=1; done
      [ "$_alive" -eq 0 ] && break
      sleep 0.1; _i=$((_i + 1))
    done
    for _g in $_groups; do kill -KILL "-$_g" 2>/dev/null; done
    kill "$hb" 2>/dev/null
    wait
  }
  # The heartbeat must not outlive the restore, however it ends.
  trap 'kill $hb 2>/dev/null; rm -rf "$WORK"' EXIT
  trap 'stop_workers; exit 130' INT
  trap 'stop_workers; exit 143' TERM
  trap 'stop_workers; exit 129' HUP
  [ -n "$DRY_RUN" ] || log "restoring $ADAPTERS from ${DATA_DIR%/}/state, $JOBS rsyncs per large tree"
  for a in $ADAPTERS; do
    # Its own process group; -w so the restore waits on it and gets its status
    # even if setsid has to fork to make it a group leader.
    setsid -w sh "$SELF" _adapter "$WORK" "$a" &
    pids="$pids $!"
  done
  for p in $pids; do
    wait "$p" || failures=$((failures + 1))
  done
  kill "$hb" 2>/dev/null
  [ "$failures" -eq 0 ] && log "restore finished in $(elapsed "$t0")"
else
  checkpoint_tree codex "$CODEX_HOME" "$CODEX_DURABLE" || failures=$((failures + 1))
  checkpoint_tree claude "$CLAUDE_CONFIG_DIR" "$CLAUDE_DURABLE" || failures=$((failures + 1))
  checkpoint_tree gemini "$GEMINI_LIVE" "$GEMINI_DURABLE" || failures=$((failures + 1))
  checkpoint_tree openclaw "$OPENCLAW_STATE_DIR" "$OPENCLAW_DURABLE" || failures=$((failures + 1))
  checkpoint_sqlite_tree "$OPENCODE_LIVE" "$OPENCODE_DURABLE" opencode.db opencode.db || failures=$((failures + 1))
  checkpoint_sqlite_tree "$HERMES_LIVE" "$HERMES_DURABLE" state.db state.db || failures=$((failures + 1))
  checkpoint_tree fx "$FX_LIVE" "$FX_DURABLE" || failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || {
  echo "agent-state: $MODE completed with $failures failed adapter(s)" >&2
  exit 1
}
