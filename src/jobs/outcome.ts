import type { ErrorKind } from '../domain/job.js';
import type { Target } from '../domain/ids.js';
import type { CodexState } from '../providers/codex/events.js';
import type { ClaudeState } from '../providers/claude/events.js';
import { JobFiles } from './store.js';

export type Outcome = { ok: true; answer: string } | { ok: false; kind: ErrorKind; detail: string; partial?: string };

export interface AttemptFacts {
  target: Target;
  mode: 'new' | 'resume';
  effort: string;
  exitCode: number | null;
  signal: string | null;
  runnerFlag: 'cancelled' | 'timeout' | 'self_check' | null;
  runnerFlagDetail?: string;
  answerFileText: string | null;
  codex?: CodexState;
  claude?: ClaudeState;
  stderrTail: string;
  spawnError?: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values codex may put on the wire for a requested effort (gpt-6-astra: ultra = xhigh + delegation). */
const WIRE_EFFORTS: Record<string, string[]> = { ultra: ['ultra', 'xhigh'] };

export function effortRejected(text: string, effort: string): boolean {
  for (const e of WIRE_EFFORTS[effort] ?? [effort]) {
    const lit = new RegExp(`Unsupported value:\\s*['"‘’]?${esc(e)}['"‘’]?\\s+is not supported`, 'i');
    if (lit.test(text)) return true;
  }
  return /reasoning[._ ]?effort/i.test(text) && /unsupported|not supported|invalid|must be one of|supported values/i.test(text);
}

const AUTH_CODEX = /\b401\b|Unauthorized|\b403\b|Forbidden|invalid_api_key|Missing bearer|refresh token|token (has )?expired|codex login|not logged in|sign in again/i;
const AUTH_CLAUDE = /Not logged in|Please run \/login|Login expired|OAuth token (has been )?revoked|Invalid API key|Authentication required|authentication_failed|\b401\b/i;
const LIMIT_CODEX = /usage limit|rate limit|Quota exceeded|\b429\b|upgrade to Plus/i;
const LIMIT_CLAUDE = /usage limit|rate limit|You've hit your|5-hour|weekly limit|\b429\b/i;
const MODEL_CODEX = /model_not_found|does not exist or you do not have access|model is not supported|Unsupported model/i;
const MODEL_CLAUDE = /model.*(not found|not available|invalid)|invalid model|issue with the selected model|may not exist or you may not have access/i;
const NET_CODEX = /stream disconnected|Connection failed|error sending request|timed out|exceeded retry limit|\b5\d\d\b/i;
const NET_CLAUDE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|overloaded|\b5\d\d\b/i;

function tail(s: string, n = 1500): string {
  const t = s.trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

export function classify(f: AttemptFacts): Outcome {
  if (f.spawnError) return { ok: false, kind: 'spawn_failed', detail: f.spawnError };
  // An error result's `result` is the error text, not a partial answer.
  const cr = f.claude?.result;
  const partial = f.target === 'codex' ? f.codex?.lastAgentMessage ?? undefined : (cr && !cr.is_error ? cr.result : undefined) ?? f.claude?.lastText ?? undefined;
  if (f.runnerFlag) return { ok: false, kind: f.runnerFlag, detail: f.runnerFlagDetail ?? '', partial };

  const stderr = f.stderrTail.replace(ANSI, '');
  if (f.target === 'codex') {
    const st = f.codex;
    const answer = (f.answerFileText ?? '').trim();
    if (f.exitCode === 0 && answer) return { ok: true, answer: f.answerFileText!.trim() };
    if (f.exitCode === 0 && !answer) return { ok: false, kind: 'empty_answer', detail: '', partial };
    const hay = [st?.turnFailed ?? '', ...(st?.errors ?? []), stderr].join('\n');
    if (f.mode === 'resume' && !st?.threadId && /no rollout found|thread\/resume failed/i.test(hay)) return { ok: false, kind: 'resume_not_found', detail: tail(hay, 400) };
    if (/already has an active writer/i.test(hay)) return { ok: false, kind: 'session_busy', detail: tail(hay, 400) };
    if (effortRejected(hay, f.effort)) return { ok: false, kind: 'effort_rejected', detail: tail(hay, 600) };
    if (AUTH_CODEX.test(hay)) return { ok: false, kind: 'auth', detail: tail(hay, 600) };
    if (LIMIT_CODEX.test(hay)) return { ok: false, kind: 'limit', detail: tail(hay, 600), partial };
    if (MODEL_CODEX.test(hay)) return { ok: false, kind: 'model', detail: tail(hay, 600) };
    if (NET_CODEX.test(st?.turnFailed ?? stderr)) return { ok: false, kind: 'network', detail: tail(hay, 600), partial };
    return { ok: false, kind: 'cli_error', detail: tail(hay || `exit ${f.exitCode ?? f.signal}`), partial };
  }

  const r = f.claude?.result;
  if (r && f.exitCode === 0 && r.subtype === 'success' && !r.is_error && (r.terminal_reason ?? 'completed') === 'completed') {
    const text = (r.result ?? '').trim();
    if (text) return { ok: true, answer: text };
    return { ok: false, kind: 'empty_answer', detail: '', partial };
  }
  const hay = [...(r?.errors ?? []), r?.result ?? '', stderr].join('\n');
  const tr = r?.terminal_reason;
  if (tr && ['aborted_streaming', 'aborted_tools', 'hook_stopped', 'stop_hook_prevented'].includes(tr)) return { ok: false, kind: 'interrupted', detail: tr, partial };
  if (tr === 'max_turns' || r?.subtype === 'error_max_turns') return { ok: false, kind: 'max_turns', detail: tr ?? r!.subtype, partial };
  if (tr === 'prompt_too_long') return { ok: false, kind: 'too_big', detail: tr };
  if (tr === 'blocking_limit' || tr === 'rapid_refill_breaker' || r?.subtype === 'error_max_budget_usd') return { ok: false, kind: 'limit', detail: tr ?? r!.subtype, partial };
  if (f.mode === 'resume' && /No conversation found with session ID/i.test(hay)) return { ok: false, kind: 'resume_not_found', detail: tail(hay, 400) };
  if (/already in use|session .* is (currently )?(in use|running)/i.test(hay)) return { ok: false, kind: 'session_busy', detail: tail(hay, 400) };
  if (/cannot use --strict-mcp-config when an enterprise MCP config/i.test(hay)) return { ok: false, kind: 'managed_mcp', detail: tail(hay, 400) };
  if (/Sandbox required but unavailable|sandbox is enabled but dependencies are missing|refusing to start without a working sandbox/i.test(hay)) return { ok: false, kind: 'sandbox_unavailable', detail: tail(hay, 600) };
  if (AUTH_CLAUDE.test(hay)) return { ok: false, kind: 'auth', detail: tail(hay, 600) };
  if (LIMIT_CLAUDE.test(hay)) return { ok: false, kind: 'limit', detail: tail(hay, 600), partial };
  if (MODEL_CLAUDE.test(hay)) return { ok: false, kind: 'model', detail: tail(hay, 600) };
  if (NET_CLAUDE.test(hay)) return { ok: false, kind: 'network', detail: tail(hay, 600), partial };
  return { ok: false, kind: 'cli_error', detail: tail(hay || `exit ${f.exitCode ?? f.signal}`), partial };
}

export interface PlannedAttempt {
  n: number;
  effort: string;
  mode: 'new' | 'resume';
  stdin: typeof JobFiles.prompt | typeof JobFiles.promptFallback;
}

/**
 * Next attempt after an outcome, or null. The only retry: a resumed session the CLI no longer knows
 * restarts once as a new session that carries the archived turns. The cap is a safety bound.
 */
export function planNext(prev: PlannedAttempt, o: Outcome, tried: PlannedAttempt[]): PlannedAttempt | null {
  if (o.ok || tried.length >= 4) return null;
  if (o.kind === 'resume_not_found' && prev.mode === 'resume' && !tried.some((t) => t.stdin === JobFiles.promptFallback)) {
    return { n: prev.n + 1, effort: prev.effort, mode: 'new', stdin: JobFiles.promptFallback };
  }
  return null;
}
