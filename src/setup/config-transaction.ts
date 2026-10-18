import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createWindowsPrivateFile, readWindowsDaclRaw, canonicalWindowsDacl, WindowsAclError } from './windows-acl.js';

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

export class SetupFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SetupFileError';
  }
}

/**
 * File identity from BigInt stats. Windows file IDs exceed 2^53, so as plain numbers two different
 * files can round to the same inode and one change would be refused as a duplicate of another.
 */
interface Identity {dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}
interface Link {file: string; target: string; identity: Identity}
export interface Snapshot {
  readonly requestedFile: string;
  readonly file: string;
  readonly text: string | null;
  readonly mode: number;
  /** DACL comparison form; informational inheritance bookkeeping is excluded. */
  readonly windowsDacl: string | null;
  /** Exact native descriptor used when applying permissions, never the comparison form. */
  readonly windowsDaclRaw: string | null;
  /** Internal comparison metadata. Never log snapshots: they contain config secrets. */
  readonly identity: Identity | null;
  readonly links: readonly Link[];
}
export interface ConfigChange {snapshot: Snapshot; text: string}
export interface ApplyOptions {
  /**
   * Private directory for the backups of replaced configurations, one subdirectory per transaction
   * with an index.json naming each original. Without it a backup is written next to its file.
   */
  backupDir?: string;
}
export interface ConfigTransaction {
  readonly backups: readonly {file: string; backupFile: string}[];
  readonly changedFiles: readonly string[];
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
function fail(kind: string, message: string): never {throw new SetupFileError(kind, message);}
function identity(stat: BigIntStats): Identity {
  return {dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs};
}
function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return a === null || b === null ? a === b : a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function sameLinks(a: readonly Link[], b: readonly Link[]): boolean {
  return a.length === b.length && a.every((link, i) => link.file === b[i]?.file && link.target === b[i]?.target && sameIdentity(link.identity, b[i]!.identity));
}

// Resolve each component so the config symlink itself is preserved by rename.
// Missing tails are allowed; dangling or cyclic symlinks are not.
async function destination(input: string): Promise<{file: string; links: Link[]}> {
  const absolute = path.resolve(input);
  const {root} = path.parse(absolute);
  let current = root;
  const links: Link[] = [];
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: BigIntStats;
    try {stat = await fs.lstat(current, {bigint: true});} catch (error) {
      if (code(error) === 'ENOENT') continue;
      fail('CONFIG_PATH_UNREADABLE', 'A configuration path cannot be inspected safely.');
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {target = await fs.realpath(current);} catch {
        fail('CONFIG_SYMLINK_INVALID', 'A configuration symlink has a missing or inaccessible target.');
      }
      links.push({file: current, target, identity: identity(stat)});
      current = target;
    }
  }
  return {file: current, links};
}

export async function readSnapshot(input: string): Promise<Snapshot> {
  const requestedFile = path.resolve(input);
  const resolved = await destination(requestedFile);
  let handle: fs.FileHandle;
  try {handle = await fs.open(resolved.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));} catch (error) {
    if (code(error) !== 'ENOENT') fail('CONFIG_UNREADABLE', 'A configuration file cannot be read safely.');
    const checked = await destination(requestedFile);
    if (checked.file !== resolved.file || !sameLinks(checked.links, resolved.links)) fail('CONFIG_CHANGED', 'A configuration path changed during inspection. Retry setup.');
    return {requestedFile, ...resolved, text: null, mode: 0o600, windowsDacl: null, windowsDaclRaw: null, identity: null};
  }
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_CONFIG_BYTES)) fail('CONFIG_INCOMPATIBLE', 'Configuration must be a regular file with one link and at most 16 MiB.');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) fail('CONFIG_OWNER', 'Configuration belongs to another user; setup cannot replace it safely.');
    const bytes = await handle.readFile();
    const windowsDaclRaw = process.platform === 'win32' ? await readWindowsDaclRaw(resolved.file) : null;
    const windowsDacl = windowsDaclRaw === null ? null : canonicalWindowsDacl(windowsDaclRaw);
    const after = await handle.stat({bigint: true});
    const checked = await destination(requestedFile);
    const live = await fs.lstat(resolved.file, {bigint: true});
    if (!sameIdentity(identity(before), identity(after)) || !sameIdentity(identity(after), identity(live)) || checked.file !== resolved.file || !sameLinks(checked.links, resolved.links)) fail('CONFIG_CHANGED', 'Configuration changed during inspection. Retry setup.');
    let text: string;
    try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);} catch {
      fail('CONFIG_ENCODING', 'Configuration is not valid UTF-8; setup left it unchanged.');
    }
    return {requestedFile, ...resolved, text, mode: Number(before.mode & 0o777n), windowsDacl, windowsDaclRaw, identity: identity(before)};
  } catch (error) {
    if (error instanceof SetupFileError) throw error;
    if (error instanceof WindowsAclError) fail(error.code, error.message);
    fail('CONFIG_UNREADABLE', 'A configuration file cannot be read safely.');
  } finally {await handle.close();}
}

async function assertUnchanged(snapshot: Snapshot): Promise<void> {
  const current = await readSnapshot(snapshot.requestedFile);
  if (snapshot.file !== current.file || snapshot.text !== current.text || snapshot.windowsDacl !== current.windowsDacl || !sameIdentity(snapshot.identity, current.identity) || !sameLinks(snapshot.links, current.links)) {
    fail('CONFIG_CHANGED', 'Configuration changed since setup inspected it. Retry setup; no concurrent edits will be overwritten.');
  }
}

async function writePrivate(file: string, text: string, mode: number, windowsDacl: string | null = null): Promise<void> {
  let handle: fs.FileHandle;
  try {
    if (process.platform === 'win32') {
      await createWindowsPrivateFile(file, windowsDacl);
      handle = await fs.open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    } else handle = await fs.open(file, 'wx', mode);
  } catch (error) {
    if (error instanceof WindowsAclError) fail(error.code, error.message);
    fail('CONFIG_WRITE_FAILED', 'Setup could not create a private configuration staging file.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) fail('CONFIG_WRITE_FAILED', 'Configuration staging file changed before setup could write it.');
    // chmod only the new staging file, never the user's existing configuration.
    if (process.platform !== 'win32') await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error instanceof SetupFileError) throw error;
    fail('CONFIG_WRITE_FAILED', 'Setup could not write its configuration staging file.');
  } finally {await handle.close();}
}

async function removeOwned(file: string): Promise<void> {
  try {await fs.unlink(file);} catch (error) {
    if (code(error) !== 'ENOENT') fail('CONFIG_CLEANUP_FAILED', 'Setup could not remove one of its temporary files.');
  }
}

interface Applied {original: Snapshot; applied: Snapshot}

export async function applyChanges(changes: readonly ConfigChange[], options: ApplyOptions = {}): Promise<ConfigTransaction> {
  const seen = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const change of changes) {
    const key = process.platform === 'win32' ? change.snapshot.file.toLowerCase() : change.snapshot.file;
    const fileIdentity = change.snapshot.identity;
    const inodeKey = fileIdentity && fileIdentity.ino !== 0n ? `${fileIdentity.dev}:${fileIdentity.ino}` : null;
    if (seen.has(key) || (inodeKey !== null && seenIdentities.has(inodeKey))) fail('CONFIG_DUPLICATE', 'Setup attempted to update the same configuration more than once.');
    seen.add(key);
    if (inodeKey !== null) seenIdentities.add(inodeKey);
    if (Buffer.byteLength(change.text, 'utf8') > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE', 'The updated configuration exceeds the 16 MiB safety limit.');
    if (Buffer.from(change.text, 'utf8').toString('utf8') !== change.text) fail('CONFIG_ENCODING', 'The updated configuration contains invalid Unicode.');
    await assertUnchanged(change.snapshot);
  }
  const backups: {file: string; backupFile: string}[] = [];
  let runDir: string | null = null;
  const backupPath = async (file: string): Promise<string> => {
    if (!options.backupDir) return `${file}.clivoxa-backup-${randomUUID()}`;
    if (!runDir) {
      runDir = path.join(options.backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      try {await fs.mkdir(runDir, {recursive: true, mode: 0o700});} catch {
        fail('CONFIG_WRITE_FAILED', 'Setup could not create its private backup directory.');
      }
    }
    return path.join(runDir, `${backups.length + 1}-${path.basename(file)}`);
  };
  const applied: Applied[] = [];
  let state: 'open' | 'committed' | 'rolled-back' = 'open';

  async function rollback(): Promise<void> {
    if (state !== 'open') return;
    const errors: unknown[] = [];
    for (const item of [...applied].reverse()) {
      let staging: string | undefined;
      try {
        await assertUnchanged(item.applied);
        if (item.original.text === null) {
          await fs.unlink(item.applied.file);
        } else {
          staging = `${item.original.file}.clivoxa-restore-${randomUUID()}`;
          await writePrivate(staging, item.original.text, item.original.mode, item.original.windowsDaclRaw);
          await assertUnchanged(item.applied);
          await fs.rename(staging, item.original.file);
          staging = undefined;
        }
      } catch (error) {errors.push(error);} finally {
        if (staging) {try {await removeOwned(staging);} catch (error) {errors.push(error);}}
      }
    }
    state = 'rolled-back';
    if (errors.length) fail('CONFIG_ROLLBACK_FAILED', 'Some configuration changes could not be restored safely. Concurrent edits were preserved; original configurations remain in the setup backups.');
  }

  try {
    for (const {snapshot, text} of changes) {
      if (snapshot.text === text) continue;
      await fs.mkdir(path.dirname(snapshot.file), {recursive: true, mode: 0o700});
      await assertUnchanged(snapshot);
      let staging: string | undefined = `${snapshot.file}.clivoxa-stage-${randomUUID()}`;
      try {
        await writePrivate(staging, text, snapshot.mode, snapshot.windowsDaclRaw);
        const staged = await fs.lstat(staging, {bigint: true});
        if (snapshot.text !== null) {
          const backupFile = await backupPath(snapshot.file);
          try {await writePrivate(backupFile, snapshot.text, snapshot.mode & 0o600);} catch (error) {
            await removeOwned(backupFile);
            throw error;
          }
          backups.push({file: snapshot.file, backupFile});
        }
        await assertUnchanged(snapshot);
        await fs.rename(staging, snapshot.file);
        staging = undefined;
        // Capture the exact installed identity; rollback requires it to still match.
        const installed = await readSnapshot(snapshot.requestedFile);
        if (installed.file !== snapshot.file || installed.text !== text || installed.identity?.dev !== staged.dev || installed.identity?.ino !== staged.ino || !sameLinks(installed.links, snapshot.links)) fail('CONFIG_CHANGED', 'Configuration changed immediately after setup wrote it; concurrent edits were preserved.');
        applied.push({original: snapshot, applied: installed});
      } finally {if (staging) await removeOwned(staging);}
    }
    // Which backup is which original: a convenience for the user, never a reason to fail.
    if (runDir) await writePrivate(path.join(runDir, 'index.json'), JSON.stringify(backups, null, 2) + '\n', 0o600).catch(() => undefined);
  } catch (error) {
    await rollback();
    if (error instanceof SetupFileError) throw error;
    if (error instanceof WindowsAclError) fail(error.code, error.message);
    fail('CONFIG_WRITE_FAILED', 'Setup could not update a configuration file; earlier changes were restored.');
  }

  return {
    backups: Object.freeze(backups),
    changedFiles: Object.freeze(applied.map(item => item.original.file)),
    rollback,
    async commit() {
      if (state !== 'open') return;
      // Verification can take time. Recheck unchanged host profiles too: a
      // successful staged MCP launch does not authorize overwriting host edits.
      for (const {snapshot} of changes) {
        await assertUnchanged(applied.find(item => item.original === snapshot)?.applied ?? snapshot);
      }
      state = 'committed';
    },
  };
}

interface LockOwner {pid: number; host: string; token: string}
async function lockOwner(file: string): Promise<LockOwner | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024) return null;
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const owner = value as Partial<LockOwner>;
    return Number.isSafeInteger(owner.pid) && owner.pid! > 0 && typeof owner.host === 'string' && typeof owner.token === 'string' ? owner as LockOwner : null;
  } catch (error) {
    if (code(error) === 'ENOENT' || error instanceof SyntaxError) return null;
    // Windows CreateNew briefly holds FileShare.None while applying the private
    // DACL. An unreadable owner is unknown, never proof of a stale lock: wait.
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'EBUSY'].includes(code(error) ?? '')) return null;
    fail('SETUP_LOCK_UNREADABLE', 'The setup lock cannot be inspected safely.');
  }
}
function isDead(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {process.kill(owner.pid, 0); return false;} catch (error) {return code(error) === 'ESRCH';}
}
function sameLock(a: LockOwner | null, b: LockOwner): boolean {
  return a?.pid === b.pid && a.host === b.host && a.token === b.token;
}

async function recoverLock(lock: string): Promise<void> {
  try {
    const stat = await fs.lstat(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SETUP_LOCK_INVALID', 'The setup lock is not a real directory; it was left untouched.');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) fail('SETUP_LOCK_INVALID', 'The setup lock ownership or permissions are unsafe; it was left untouched.');
  } catch (error) {
    if (code(error) === 'ENOENT') return;
    if (error instanceof SetupFileError) throw error;
    fail('SETUP_LOCK_UNREADABLE', 'The setup lock cannot be inspected safely.');
  }
  const ownerFile = path.join(lock, 'owner.json');
  const owner = await lockOwner(ownerFile);
  if (!owner || !isDead(owner)) return;
  // A recovery claimant must re-read the owner after claiming, so it cannot
  // accidentally remove a new lock acquired after an earlier stale lock.
  const recovery = path.join(lock, 'recovery');
  try {await fs.mkdir(recovery, {mode: 0o700});} catch (error) {
    if (code(error) === 'EEXIST' || code(error) === 'ENOENT') return;
    fail('SETUP_LOCK_RECOVERY', 'A previous setup lock could not be recovered safely.');
  }
  try {
    if (!sameLock(await lockOwner(ownerFile), owner) || !isDead(owner)) return;
    await fs.unlink(ownerFile);
  } finally {
    try {await fs.rmdir(recovery);} catch (error) {
      if (code(error) !== 'ENOENT') fail('SETUP_LOCK_RECOVERY', 'A previous setup lock could not be recovered safely.');
    }
  }
  try {await fs.rmdir(lock);} catch (error) {
    if (code(error) !== 'ENOENT' && code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') fail('SETUP_LOCK_RECOVERY', 'A previous setup lock could not be recovered safely.');
  }
}

export async function withSetupLock<T>(root: string, action: () => Promise<T>, options: {timeoutMs?: number} = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 60_000) fail('SETUP_LOCK_TIMEOUT', 'Setup lock timeout must be between zero and 60 seconds.');
  try {await fs.mkdir(root, {recursive: true, mode: 0o700});} catch {
    fail('SETUP_LOCK_UNWRITABLE', 'Setup cannot create its installation directory.');
  }
  const lock = path.join(await fs.realpath(root), '.setup.lock');
  const ownerFile = path.join(lock, 'owner.json');
  const owner: LockOwner = {pid: process.pid, host: hostname(), token: randomUUID()};
  const deadline = Date.now() + timeout;
  for (;;) {
    try {await fs.mkdir(lock, {mode: 0o700}); break;} catch (error) {
      if (code(error) !== 'EEXIST') fail('SETUP_LOCK_UNWRITABLE', 'Setup cannot acquire its installation lock.');
    }
    await recoverLock(lock);
    if (Date.now() >= deadline) fail('SETUP_LOCK_BUSY', 'Another setup may be running. Close other setup processes and retry. An incomplete lock must be inspected before removing it.');
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
  try {await writePrivate(ownerFile, JSON.stringify(owner), 0o600);} catch (error) {
    // Only this process can have acquired a fresh, empty lock directory.
    await removeOwned(ownerFile);
    await fs.rmdir(lock);
    throw error;
  }
  const lockIdentity = identity(await fs.lstat(lock, {bigint: true}));
  let result: T;
  let actionError: unknown;
  let failed = false;
  try {result = await action();} catch (error) {failed = true; actionError = error;}
  let currentLock: BigIntStats;
  try {currentLock = await fs.lstat(lock, {bigint: true});} catch {
    fail('SETUP_LOCK_CHANGED', 'Setup lock ownership changed; it was left untouched.');
  }
  if (!currentLock.isDirectory() || currentLock.isSymbolicLink() || currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino || !sameLock(await lockOwner(ownerFile), owner)) fail('SETUP_LOCK_CHANGED', 'Setup lock ownership changed; it was left untouched.');
  try {await fs.unlink(ownerFile); await fs.rmdir(lock);} catch {
    fail('SETUP_LOCK_RELEASE', 'Setup could not release its lock safely.');
  }
  if (failed) throw actionError;
  return result!;
}
