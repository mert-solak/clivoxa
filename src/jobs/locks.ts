import fs from 'node:fs';
import path from 'node:path';
import { ensureDir0700, exists, readJsonSafe, sleepSync, writeJsonAtomic } from '../system/fs.js';
import { within } from '../system/paths.js';
import { isGone } from '../system/platform/index.js';
import { nonce, targetFromName, type Target } from '../domain/ids.js';

export class LockConflict extends Error {
  constructor(public kind: 'workdir' | 'session', public jobId: string) {
    super(`${kind} lock held by ${jobId}`);
  }
}

/** A finished write job on an overlapping workdir has not confirmed its protected-file restore. */
export class RestorePending extends Error {
  constructor(public jobId: string) {
    super(`protected-file restore of ${jobId} is pending`);
  }
}

/** Retries the restore of a finished job; true once the restore is confirmed and its marker cleared. */
export type RetryRestore = (jobId: string) => boolean;

interface LockFile {
  job_id: string;
  kind: 'workdir' | 'session';
  path?: string;
  target?: string;
  session_id?: string;
  created_at: string;
  created_at_ms: number;
}

/** Callback deciding whether the job owning a lock is still active (not finished, not dead). */
export type IsActive = (jobId: string) => 'active' | 'finished' | 'unknown';

const MUTEX = '.mutex';

/** The mutex owner record exactly as written, or null. */
function readRecord(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Delete the mutex at `dir` only if its owner record still reads `expected` (null: none). A record that
 * reads otherwise is left untouched; a matching one is moved aside first (atomic: one remover wins) and
 * compared there, and only an empty directory is removed, so a mutex another process created at `dir`
 * in the meantime is never deleted.
 */
function removeMutexIf(dir: string, expected: string | null): boolean {
  const file = path.join(dir, 'owner.json');
  // Moving a live owner's record aside, even briefly, would make its own release fail and leave its mutex until the stale rule fires.
  if (expected !== null && readRecord(file) !== expected) return false;
  const claimed = `${dir}.${nonce(8)}.gone`;
  try {
    if (expected !== null) fs.renameSync(file, claimed);
    if (readRecord(claimed) !== expected) {
      // Not the mutex the caller judged: give its record back unless a newer mutex holds the path.
      fs.linkSync(claimed, file);
      return false;
    }
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(claimed);
    } catch {
      /* not claimed */
    }
  }
}

/** Cross-process mutex built on mkdir. Steals only stale mutexes; releases only its own. */
export function withMutex<T>(locksDir: string, fn: () => T): T {
  ensureDir0700(locksDir);
  const dir = path.join(locksDir, MUTEX);
  const file = path.join(dir, 'owner.json');
  // The random token makes this acquisition's record unique.
  const record = JSON.stringify({ pid: process.pid, at: Date.now(), token: nonce(8) });
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      try {
        fs.writeFileSync(file, record, { mode: 0o600 });
      } catch (error) {
        // An ownerless mutex would block every host until the stale-steal rule fires.
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const seen = readRecord(file);
      let owner: { pid: number } | null = null;
      try {
        owner = JSON.parse(seen ?? 'null');
      } catch {
        /* partial or garbled: ownerless */
      }
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      // Critical sections take milliseconds: a dead owner after 10 s, or any owner after 60 s (stuck, or a reused pid), loses it.
      // Only the mutex judged here goes: a fresh one another waiter created since is left alone.
      if (((age > 10_000 && (!owner || isGone(owner.pid))) || age > 60_000) && removeMutexIf(dir, seen)) continue;
      if (Date.now() > deadline) throw new Error('clivoxa kilit mutex zaman aşımı');
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    // After a steal (this section overran the stale limit) the path holds another process's mutex: it stays.
    removeMutexIf(dir, record);
  }
}

const LOCK_NAME = /^(workdir|session)-(.*)\.json$/;

function listLocks(locksDir: string): { file: string; lock: LockFile; unreadable?: true }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(locksDir).filter((n) => LOCK_NAME.test(n));
  } catch {
    return [];
  }
  const out: { file: string; lock: LockFile; unreadable?: true }[] = [];
  for (const n of names) {
    const file = path.join(locksDir, n);
    const lock = readJsonSafe<LockFile>(file);
    if (lock?.job_id) out.push({ file, lock });
    else if (!lock && exists(file)) {
      // Held open (scanner, backup) or EMFILE: the name still says whose lock it is, `${kind}-${jobId}.json`.
      const [, kind, jobId] = LOCK_NAME.exec(n)!;
      out.push({ file, lock: { job_id: jobId!, kind: kind as LockFile['kind'], created_at: '', created_at_ms: 0 }, unreadable: true });
    }
  }
  return out;
}

function stale(l: LockFile, isActive: IsActive): boolean {
  return isActive(l.job_id) === 'finished';
}

export interface Acquire {
  workdir?: string;
  session?: { target: Target; id: string };
}

/**
 * Pending-restore markers. Every write job records one, together with its workdir lock and
 * before its runner starts, so the record exists even when a later failure could not write anything.
 * Only a confirmed restore removes it. Until then no job may start on an overlapping workdir: its
 * snapshot would take the unrestored files as the original.
 */
const PENDING = 'restore-pending';

/** Jobs with a pending restore on a workdir overlapping `dir`. An unreadable marker counts (its name is the job id). */
function pendingRestoresOn(locksDir: string, dir: string): string[] {
  const markers = path.join(locksDir, PENDING);
  let names: string[];
  try {
    names = fs.readdirSync(markers).filter((n) => n.endsWith('.json'));
  } catch (e) {
    // Only a missing directory means "nothing pending"; any other error must not read as a clean workdir.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((n) => {
      const p = readJsonSafe<{ path?: unknown }>(path.join(markers, n))?.path;
      return typeof p !== 'string' || within(dir, p) || within(p, dir);
    })
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

/**
 * Retry every finished job's pending restore on `dir`. A running writer is skipped only when
 * `skipLive` (a read beside a write job is warned about elsewhere); a job in an unknown state never is.
 */
function settle(locksDir: string, dir: string, isActive: IsActive, retry: RetryRestore, skipLive: boolean): void {
  for (const id of pendingRestoresOn(locksDir, dir)) {
    const state = isActive(id);
    if (state === 'active' && skipLive) continue;
    if (state !== 'finished' || !retry(id)) throw new RestorePending(id);
  }
}

/** Where the pending-restore marker of `jobId` lives. */
export function restorePendingFile(locksDir: string, jobId: string): string {
  return path.join(locksDir, PENDING, `${jobId}.json`);
}

/** The job's protected files are restored, or were never snapshotted: nobody needs to wait for it. */
export function clearRestorePending(locksDir: string, jobId: string): void {
  try {
    fs.unlinkSync(restorePendingFile(locksDir, jobId));
  } catch {
    /* none */
  }
}

/**
 * Before a read job on `dir`: retry pending restores of finished write jobs (throws RestorePending).
 * Running under the lock mutex, no write job can start on the workdir meanwhile.
 */
export function settleRestores(locksDir: string, dir: string, isActive: IsActive, retry: RetryRestore): void {
  withMutex(locksDir, () => settle(locksDir, dir, isActive, retry, true));
}

/**
 * Acquire the requested locks atomically for `jobId` (throws LockConflict, or RestorePending when an
 * earlier write job on the workdir still has to restore protected files and the retry fails).
 */
export function acquireLocks(locksDir: string, jobId: string, req: Acquire, isActive: IsActive, retry: RetryRestore = () => false): void {
  if (!req.workdir && !req.session) return;
  withMutex(locksDir, () => {
    const existing = listLocks(locksDir);
    for (const { file, lock, unreadable } of existing) {
      if (stale(lock, isActive)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
        continue;
      }
      // A live job's unreadable lock may cover any path or session: assume it overlaps.
      if (unreadable && (lock.kind === 'workdir' ? req.workdir : req.session)) throw new LockConflict(lock.kind, lock.job_id);
      if (req.workdir && lock.kind === 'workdir' && lock.path && (within(req.workdir, lock.path) || within(lock.path, req.workdir))) {
        throw new LockConflict('workdir', lock.job_id);
      }
      if (req.session && lock.kind === 'session' && targetFromName(lock.target) === req.session.target && lock.session_id === req.session.id) {
        throw new LockConflict('session', lock.job_id);
      }
    }
    if (req.workdir) settle(locksDir, req.workdir, isActive, retry, false);
    const now = Date.now();
    if (req.workdir) {
      ensureDir0700(path.join(locksDir, PENDING));
      writeJsonAtomic(restorePendingFile(locksDir, jobId), { job_id: jobId, path: req.workdir, created_at: new Date(now).toISOString(), created_at_ms: now });
      writeJsonAtomic(path.join(locksDir, `workdir-${jobId}.json`), { job_id: jobId, kind: 'workdir', path: req.workdir, created_at: new Date(now).toISOString(), created_at_ms: now } satisfies LockFile);
    }
    if (req.session) {
      writeJsonAtomic(path.join(locksDir, `session-${jobId}.json`), { job_id: jobId, kind: 'session', target: req.session.target, session_id: req.session.id, created_at: new Date(now).toISOString(), created_at_ms: now } satisfies LockFile);
    }
  });
}

export function releaseLocks(locksDir: string, jobId: string): void {
  for (const k of ['workdir', 'session']) {
    try {
      fs.unlinkSync(path.join(locksDir, `${k}-${jobId}.json`));
    } catch {
      /* not held */
    }
  }
}

/** Active write jobs whose workdir overlaps `dir` (for read-alongside-write warnings). */
export function writeJobsOn(locksDir: string, dir: string, isActive: IsActive): string[] {
  return listLocks(locksDir)
    .filter(({ lock }) => lock.kind === 'workdir' && lock.path && (within(dir, lock.path) || within(lock.path, dir)) && isActive(lock.job_id) !== 'finished')
    .map(({ lock }) => lock.job_id);
}
