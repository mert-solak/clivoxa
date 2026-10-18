import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

/** Short private paths also fit Unix-domain socket limits used by CLI sandboxes. */
export function privateTemporaryDirectory(prefix = 'clivoxa-'): string {
  const root = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const dir = fs.mkdtempSync(path.join(root, prefix));
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return fs.realpathSync.native(dir);
}

/** mkdir -p with mode 0700 on every directory we create (existing dirs are left alone). */
export function ensureDir0700(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function tmpName(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
}

/** Write a file atomically (tmp file with O_EXCL + 0600, then rename). */
export function writeAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  const tmp = tmpName(file);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameReplacing(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * rename(2) over an existing file. On Windows the replace fails while another process (the MCP
 * server polling meta.json, an indexer or AV scanner) briefly holds the target open, so retry for
 * up to about a second before giving up.
 */
function renameReplacing(from: string, to: string): void {
  for (let delay = 10; ; delay *= 2) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !TRANSIENT_RENAME_ERRORS.has(code) || delay > 640) throw error;
      sleepSync(delay);
    }
  }
}

/**
 * Create `file` with `data` only if it does not exist yet (hard-link of a fully written tmp file).
 * Returns true if this call created it. Readers never see a partial file.
 */
export function linkOnce(file: string, data: string, mode = 0o600): boolean {
  const tmp = tmpName(file);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, Buffer.from(data, 'utf8'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function writeJsonAtomic(file: string, obj: unknown): void {
  writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function readJsonSafe<T = unknown>(file: string): T | null {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (i === 0 && e instanceof SyntaxError) {
        sleepSync(50);
        continue;
      }
      return null;
    }
  }
  return null;
}

export function readTextSafe(file: string, maxBytes = 50_000_000): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read the last `maxBytes` of a file as UTF-8 (lossy at the cut). */
export function readTail(file: string, maxBytes: number): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Open a regular file for reading without following a symlink at the final component.
 * Returns the content (≤ maxBytes, else null) or null.
 */
export function readNoFollow(file: string, maxBytes: number): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    // Windows has no O_NOFOLLOW and open() follows symlinks and junctions: the path itself must be a
    // regular file, and the opened handle must be that same file.
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    const size = Number(st.size);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return { text: buf.subarray(0, n).toString('utf8'), truncated: size > maxBytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function appendFileSafe(file: string, text: string): void {
  try {
    fs.appendFileSync(file, text, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
