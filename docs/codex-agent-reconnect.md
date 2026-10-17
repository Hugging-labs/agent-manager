# Automatic reconnect for an authorized agent delivery

A scanner/timer sending a message through `POST /api/agents/:id/prompt?from=SOURCE`
can now recover an existing shared Codex thread that is saved but unloaded. It
uses the same verified recovery plan as the Reader, with the original thread ID,
model, cwd, approval settings and permission profile. It does not create a new
conversation, boot the daemon or a standalone TUI, interrupt work, replay old
input, or grant additional permissions.

The explicit `/api/sessions/:id/reconnect` UI action still requires the operator.
An agent or timer should not impersonate that role. It submits its already
authorized task through the attributed agent-prompt endpoint with a stable UUID
`requestId`. Accepted or uncertain message receipts are checked before recovery:
a transport retry cannot wake the task or queue the same message again.

Recovery requires no live writer, pending native input, active goal or unfinished
last turn. The source identity and target binding are checked again immediately
before native recovery and delivery. An already-busy thread is not interrupted;
the native queue handles a concurrent turn that begins just before submission.

Saved settings that cannot be reconstructed exactly require review. Failed,
stale or uncertain recovery does not queue the message in that attempt: simply
seeing a loaded thread is not proof that its settings were restored. An uncertain
**message delivery** receipt is never automatically replayed; inspect the actual
conversation. A successful queue acknowledgement means accepted, not finished.

The scanner's decision to invoke the agent remains outside this change. For HF
Release Radar, collection and content-fingerprint comparison already precede
`/prompt`; no new/modified messages means no model invocation. This change does
not modify the timer, collector, schedule, website or scanner state.

Validation includes an isolated full HTTP path through AM, a native daemon
fixture, real recovery-plan parsing and the writer/queue check against a temporary
SQLite database. It verifies exact restored settings, original history bytes,
source attribution, one queue operation and a passive retry after unloading.
No real inference is needed for this test.
