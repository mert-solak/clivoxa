import fs from 'node:fs';
import path from 'node:path';
import type { Config, Layout } from '../config/config.js';
import { JOB_ID_RE, isJobOf, jobIdTime, targetFromName, type Target } from '../domain/ids.js';
import { exists, linkOnce, readJsonSafe, writeJsonAtomic } from '../system/fs.js';
import type { JobRequest, JobResult, Meta } from '../domain/job.js';
import { PROTECT_DIR } from '../security/protected-files.js';

/** Names of the files that make up a job directory (the on-disk job protocol). */
export const JobFiles = {
  request: 'request.json',
  meta: 'meta.json',
  prompt: 'prompt.md',
  promptFallback: 'prompt.fallback.md',
  runner: 'runner.json',
  runnerLog: 'runner.log',
  events: 'events.jsonl',
  stderr: 'stderr.log',
  answer: 'answer.md',
  partial: 'answer.partial.md',
  changes: 'changes.json',
  cancelRequested: 'cancel_requested',
  cancelAck: 'cancel_ack',
  result: 'result.json',
  exitCode: 'exit_code',
  /** Protected-file snapshots and replaced versions (layout owned by security/protected-files). */
  protect: PROTECT_DIR,
} as const;

/** Answer file the counterpart CLI writes for attempt `n` (Codex `-o`). */
export function attemptAnswerFile(n: number): string {
  return `answer.attempt${n}.md`;
}

/** Owner-only settings file the runner hands to Claude attempt `n` (`--settings`); removed when the attempt ends. */
export function attemptSettingsFile(n: number): string {
  return `claude-settings.attempt${n}.json`;
}

export interface RunnerInfo {
  pid: number;
  marker: string;
  started_at_ms: number;
}

/** The job request; null when it is missing or names no known target. */
export function readRequest(dir: string): JobRequest | null {
  const req = readJsonSafe<JobRequest>(path.join(dir, JobFiles.request));
  if (!req) return null;
  const target = targetFromName(req.target);
  return target ? { ...req, target } : null;
}
export function readMeta(dir: string): Meta | null {
  const meta = readJsonSafe<Meta>(path.join(dir, JobFiles.meta));
  return meta ? { ...meta, target: targetFromName(meta.target) ?? meta.target } : null;
}
export function writeRequest(dir: string, req: JobRequest): void {
  writeJsonAtomic(path.join(dir, JobFiles.request), req);
}
export function writeMeta(dir: string, meta: Meta): void {
  writeJsonAtomic(path.join(dir, JobFiles.meta), meta);
}
export function readResult(dir: string): JobResult | null {
  return readJsonSafe<JobResult>(path.join(dir, JobFiles.result));
}
export function readRunner(dir: string): RunnerInfo | null {
  return readJsonSafe<RunnerInfo>(path.join(dir, JobFiles.runner));
}
/** The marker the runner recorded about itself (independent of how the caller spells the job dir). */
export function runnerMarker(r: RunnerInfo, dir: string): string {
  return typeof r.marker === 'string' && r.marker ? r.marker : `--clivoxa-runner ${dir}`;
}

/** The job directory for `id`, only when it is a real directory directly inside `jobsReal`. */
export function resolveJobDir(jobsReal: string, id: string): string | null {
  if (!JOB_ID_RE.test(id)) return null;
  const dir = path.join(jobsReal, id);
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (path.dirname(fs.realpathSync.native(dir)) !== jobsReal) return null;
    return dir;
  } catch {
    return null;
  }
}

export function isFinished(dir: string): boolean {
  return exists(path.join(dir, JobFiles.exitCode));
}

/** Write the terminal result once (reaper / force-cancel); a second writer gains nothing. */
export function writeFinalOnce(dir: string, r: JobResult, code: number): boolean {
  const created = linkOnce(path.join(dir, JobFiles.result), JSON.stringify(r, null, 2) + '\n');
  if (!created) {
    // The runner died between result.json and exit_code: commit what it wrote.
    if (!isFinished(dir)) {
      const prev = readResult(dir);
      linkOnce(path.join(dir, JobFiles.exitCode), `${prev?.status === 'done' ? 0 : 1}\n`);
    }
    return false;
  }
  linkOnce(path.join(dir, JobFiles.exitCode), `${code}\n`);
  return true;
}

export function updateMeta(dir: string, fn: (m: Meta) => void): Meta | null {
  const m = readMeta(dir);
  if (!m) return null;
  fn(m);
  writeMeta(dir, m);
  return m;
}

/** Recent job dirs for a target, newest first (by id = timestamp). */
export function listJobDirs(lay: Layout, target: Target, limit: number): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(lay.jobs).filter((n) => isJobOf(n, target));
  } catch {
    return [];
  }
  names.sort().reverse();
  return names.slice(0, limit).map((n) => path.join(lay.jobs, n));
}

/** Jobs that may still be running (recent enough and without exit_code). */
export function runningJobs(cfg: Config, lay: Layout, target?: Target): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(lay.jobs).filter((n) => JOB_ID_RE.test(n) && (!target || isJobOf(n, target)));
  } catch {
    return [];
  }
  const horizon = Date.now() - (cfg.maxJobMinutes + 15) * 60_000 - 86400_000; // tolerate clock/timezone skew
  return names
    .filter((n) => {
      const t = jobIdTime(n);
      return Number.isNaN(t) || t >= horizon;
    })
    .map((n) => path.join(lay.jobs, n))
    .filter((d) => !isFinished(d));
}
