// Imported first by main.tsx: ES modules run in import order, so this cleans
// the address before any other module reads `location` at load time. The edge
// has already set its session cookie by the time this document loads, so a
// reload of the cleaned address still authenticates.
import { stripForeignParams } from './lib/appUrl';

try { stripForeignParams(); } catch { /* history unavailable: links still use the allowlist */ }
