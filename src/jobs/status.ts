import path from 'node:path';
import type { Config, Layout } from '../config/config.js';
import { exists, linkOnce, readTextSafe, sleepSync } from '../system/fs.js';
import { descendants, probe, signalAll, isGone } from '../system/platform/index.js';
import { finalizeProtect } from '../security/protected-files.js';
import { realpathOr } from '../system/paths.js';
import { msg } from '../shared/messages.js';
import { clearRestorePending, releaseLocks } from './locks.js';
import { JobFiles, isFinished, readMeta, readRequest, readResult, readRunner, resolveJobDir, runnerMarker, updateMeta, writeFinalOnce } from './store.js';
import type { ErrorKind, JobRequest, JobResult, JobView } from '../domain/job.js';

/** runner.json marker of a reaper that claimed a job whose runner never started. */
const REAPED_MARKER = 'clivoxa-reaped';

function elapsedS(req: JobRequest, res: JobResult | null): number {
  const end = res?.finished_at ? Date.parse(res.finished_at) : Date.now();
  return Math.max(0, Math.round((end - req.created_at_ms) / 1000));
}

/** Stop the identity-verified child of a job whose runner is gone; false while that cannot be shown. */
function stopOrphanedChild(dir: string): boolean {
  const meta = readMeta(dir);
  // A meta file that exists but cannot be read (scanner, EMFILE) may name a live child: never assume none.
  if (!meta) return !exists(path.join(dir, JobFiles.meta));
  const child = meta.child;
  if (!child) return true;
  const liveness = probe(child.pid, child.marker);
  if (liveness === 'unknown') return false;
  if (liveness === 'alive') {
    signalAll([child.pid, ...descendants([child.pid])], 'SIGTERM');
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !isGone(child.pid)) sleepSync(100);
    if (!isGone(child.pid)) signalAll([child.pid, ...descendants([child.pid])], 'SIGKILL');
    if (!isGone(child.pid)) return false;
  }
  return true;
}

export interface Abandonment {
  kind: ErrorKind;
  message: string;
  by: JobResult['by'];
  exitCode: number;
  /**
   * 'required': a failed restore aborts the finalization (the job stays unfinished and locked, and
   * the error reaches the caller). 'best-effort': the job is finalized regardless.
   */
  protection: 'required' | 'best-effort';
}

/**
 * Finalize a job whose runner is gone (reaped orphan or forced cancel): stop its child, restore
 * protected files, write the terminal result once and release its locks. 'pending' means the
 * child could not be shown to be stopped, so the job is left running.
 */
export function abandonJob(cfg: Config, lay: Layout, dir: string, req: JobRequest, a: Abandonment): 'finalized' | 'pending' {
  if (!stopOrphanedChild(dir)) return 'pending';
  if (isFinished(dir)) {
    // Another finalizer committed first; releasing a finished job's locks is always safe.
    releaseLocks(lay.locks, req.job_id);
    return 'finalized';
  }
  if (req.access === 'write') {
    let summary = null;
    let restored = false;
    try {
      summary = finalizeProtect(dir, cfg.protectedPolicy);
      restored = true;
    } catch (error) {
      if (a.protection === 'required') throw error;
      // Best effort still finalizes; its pending-restore marker keeps later jobs off the workdir.
      updateMeta(dir, (m) => m.warnings.push(msg('protect_restore_failed')));
    }
    if (summary) updateMeta(dir, (m) => (m.protected = summary!));
    if (restored) clearRestorePending(lay.locks, req.job_id);
  }
  writeFinalOnce(dir, { status: 'error', error_kind: a.kind, error_message: a.message, by: a.by, finished_at: new Date().toISOString(), child_code: null, has_answer: false, partial_answer: exists(path.join(dir, JobFiles.partial)) }, a.exitCode);
  releaseLocks(lay.locks, req.job_id);
  return 'finalized';
}

/**
 * Retry the protected-file restore of a finished write job that could not confirm it.
 * true once confirmed: the pending marker is cleared and jobs on its workdir may start again.
 */
export function retryRestore(cfg: Config, lay: Layout, jobId: string): boolean {
  const dir = resolveJobDir(realpathOr(lay.jobs), jobId);
  if (!dir || !isFinished(dir)) return false;
  try {
    const summary = finalizeProtect(dir, cfg.protectedPolicy);
    if (summary) updateMeta(dir, (m) => (m.protected = summary));
  } catch {
    return false;
  }
  clearRestorePending(lay.locks, jobId);
  return true;
}

/**
 * Authoritative job status: exit_code + result.json are final; otherwise runner liveness decides.
 * With `reap`, dead runners are finalized (idempotent across server instances).
 */
export function computeStatus(cfg: Config, lay: Layout, dir: string, opts: { reap: boolean }): JobView | null {
  const req = readRequest(dir);
  if (!req) return null;
  const jobId = req.job_id;
  const warnings: string[] = [];
  const final = (): JobView => {
    const res = readResult(dir);
    const meta = readMeta(dir);
    const status = res ? res.status : (readTextSafe(path.join(dir, JobFiles.exitCode)) ?? '').trim() === '0' ? 'done' : 'error';
    const answer = status === 'done' ? readTextSafe(path.join(dir, JobFiles.answer)) : null;
    const partial = status !== 'done' ? readTextSafe(path.join(dir, JobFiles.partial)) : null;
    return {
      job_id: jobId, target: req.target, status, job_dir: dir, elapsed_s: elapsedS(req, res), request: req, meta,
      result: res ?? { status: status === 'done' ? 'done' : 'error', error_kind: 'internal', error_message: msg('internal', { detail: 'result.json yok' }), by: 'runner', finished_at: new Date().toISOString(), child_code: null, has_answer: !!answer, partial_answer: !!partial },
      answer, partial_answer: partial, last_activity: null, warnings,
    };
  };
  if (isFinished(dir)) return final();
  const running = (phase?: string): JobView => {
    const meta = readMeta(dir);
    return {
      job_id: jobId, target: req.target, status: 'running', phase: phase ?? meta?.phase, job_dir: dir, elapsed_s: elapsedS(req, null), request: req,
      meta, result: null, answer: null, partial_answer: null, last_activity: meta?.progress?.summary ?? null, warnings,
    };
  };
  const runner = readRunner(dir);
  if (!runner) {
    if (Date.now() - req.created_at_ms < cfg.startupGraceMs) return running('starting');
    if (!opts.reap) return running('starting');
    if (readRunner(dir)) return computeStatus(cfg, lay, dir, opts);
    // A runner record that exists but cannot be read (held by a scanner, EMFILE) belongs to a runner
    // that started: never reap it as one that did not.
    if (exists(path.join(dir, JobFiles.runner))) {
      warnings.push(msg('status_uncertain'));
      return running();
    }
    // Take the job the way a runner does (one hard link wins) before finalizing it. A runner that
    // starts late either claimed first, and is probed instead, or finds the claim taken and exits
    // (runner/main.ts) without touching the workdir whose locks this reap releases.
    let claimed: boolean;
    try {
      claimed = linkOnce(path.join(dir, JobFiles.runner), JSON.stringify({ pid: 0, marker: REAPED_MARKER, started_at_ms: Date.now() }) + '\n');
    } catch {
      warnings.push(msg('status_uncertain'));
      return running('starting');
    }
    if (!claimed) return computeStatus(cfg, lay, dir, opts);
    const r = abandonJob(cfg, lay, dir, req, { kind: 'runner_start_failed', message: msg('runner_start_failed'), by: 'reaper', exitCode: 1, protection: 'best-effort' });
    if (r === 'pending') {
      warnings.push(msg('status_uncertain'));
      return running('starting');
    }
    return final();
  }
  const l = probe(runner.pid, runnerMarker(runner, dir));
  if (l === 'alive') return running();
  if (l === 'unknown') {
    warnings.push(msg('status_uncertain'));
    return running();
  }
  if (isFinished(dir)) return final();
  if (!opts.reap) return running();
  // A reaper's claim (pid 0 probes as dead) whose finalization has not completed yet.
  const r = runner.marker === REAPED_MARKER
    ? abandonJob(cfg, lay, dir, req, { kind: 'runner_start_failed', message: msg('runner_start_failed'), by: 'reaper', exitCode: 1, protection: 'best-effort' })
    : abandonJob(cfg, lay, dir, req, { kind: 'orphaned', message: msg('orphaned'), by: 'reaper', exitCode: 1, protection: 'best-effort' });
  if (r === 'pending') {
    warnings.push(msg('status_uncertain'));
    return running();
  }
  return final();
}
