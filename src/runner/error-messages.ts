import type { Config } from '../config/config.js';
import type { ErrorKind } from '../domain/job.js';
import { msg } from '../shared/messages.js';
import { redact } from '../shared/redact.js';

/** The user-facing message for a failed job, by error kind (details are redacted and shortened). */
export function jobErrorMessage(target: 'codex' | 'claude', kind: ErrorKind, detail: string, cfg: Config): string {
  const d = redact(detail, 'all').text.replace(/\s+/g, ' ').slice(0, 400);
  switch (kind) {
    case 'auth': return msg(target === 'codex' ? 'auth_codex' : 'auth_claude');
    case 'limit': return msg('limit', { detail: d });
    case 'network': return msg('network', { detail: d });
    case 'model': return msg('model', { detail: d });
    case 'effort_rejected': return msg('effort_exhausted', { list: d.slice(0, 120) });
    case 'cancelled': return msg('cancelled');
    case 'timeout': return msg('timeout', { min: cfg.maxJobMinutes });
    case 'self_check': return msg('self_check', { detail: d });
    case 'empty_answer': return msg('empty_answer');
    case 'interrupted':
    case 'max_turns': return msg('interrupted', { detail: d });
    case 'too_big': return msg('too_big_cli');
    case 'session_busy': return msg('session_busy', { job_id: '(CLI)' });
    case 'managed_mcp': return msg('managed_mcp');
    case 'sandbox_unavailable': return msg('sandbox_unavailable', { detail: d });
    case 'mcp_isolation_failed':
    case 'workdir_scan_incomplete':
    case 'codex_profile_unverified':
    case 'codex_write_unverified':
    case 'bin_missing':
    case 'cli_too_old': return d;
    case 'spawn_failed':
      // An over-long command line is not a missing CLI (Windows: ENAMETOOLONG, POSIX: E2BIG).
      if (/\b(ENAMETOOLONG|E2BIG)\b/.test(d)) return msg('command_too_long', { cli: target, detail: d });
      return msg('bin_missing', { cli: target === 'codex' ? 'codex' : 'claude', var: target === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN' }) + ` (${d})`;
    case 'resume_not_found': return msg('cli_error', { detail: d });
    case 'orphaned': return msg('orphaned');
    case 'runner_start_failed': return msg('runner_start_failed');
    case 'cli_error': return msg('cli_error', { detail: d });
    default: return msg('internal', { detail: d });
  }
}
