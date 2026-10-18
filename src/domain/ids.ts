import { randomBytes, randomUUID } from 'node:crypto';

/** The counterpart CLI a server instance runs: Codex for Claude hosts, Claude for Codex hosts. */
export type Target = 'codex' | 'claude';

/** A target from configuration or persisted data; anything else is null. */
export function targetFromName(name: string | undefined): Target | null {
  return name === 'codex' || name === 'claude' ? name : null;
}

/** The MCP tool through which a host reaches `target`. */
export type AskToolName = `ask_${Target}`;
export function askToolName(target: Target): AskToolName {
  return `ask_${target}`;
}

/** Job ids: YYYYMMDD-HHMMSS-<target>-<8 hex>. Sorts chronologically; strict charset. */
export const JOB_ID_RE = /^\d{8}-\d{6}-(codex|claude)-[0-9a-f]{8}$/;
/** Generic 8-4-4-4-12 hex UUID (Codex thread ids are UUIDv7, Claude session ids v4). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function newJobId(target: Target, now: Date = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${d}-${t}-${target}-${randomBytes(4).toString('hex')}`;
}

export function jobTarget(jobId: string): Target | null {
  const m = JOB_ID_RE.exec(jobId);
  return m ? targetFromName(m[1]) : null;
}

/** Whether a job id (or job directory name) belongs to `target`. */
export function isJobOf(jobId: string, target: Target): boolean {
  return jobTarget(jobId) === target;
}

/** Local timestamp encoded in a job id, in ms since epoch (NaN if malformed). */
export function jobIdTime(jobId: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(jobId);
  if (!m) return NaN;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
}

export function newUuid(): string {
  return randomUUID();
}

export function nonce(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

export function normalizeUuid(s: string): string | null {
  const v = s.trim().toLowerCase();
  return UUID_RE.test(v) ? v : null;
}
