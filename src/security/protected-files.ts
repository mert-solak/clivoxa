import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir0700, readJsonSafe, writeJsonAtomic } from '../system/fs.js';
import { METADATA_DIRS, PROTECTED_DIRS, PROTECTED_FILES, PROTECTED_IGNORE, PROTECTED_REPORT_ONLY } from './policy.js';
import { caseFold, within } from '../system/paths.js';
import { findGitEntries, looksLikeGitDir } from './git-layout.js';
import type { ProtectedItem, ProtectedSummary } from '../domain/job.js';

const MAX_COPY = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_TOTAL_COPY = 20 * 1024 * 1024;

interface Entry {
  rel: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  mode: number;
  size: number;
  sha?: string;
  link?: string;
  copied?: boolean;
}

interface Manifest {
  snapshotted_at_ms: number;
  root: string;
  entries: Entry[];
  /** Extra paths watched besides PROTECTED_DIRS/FILES (git internals of every repository in the workdir). */
  watch: string[];
  existing_git: string[];
  /** The `.git` walk at snapshot time saw everything (else new-looking `.git`s are only reported). */
  git_complete: boolean;
  /** The workdir itself looked like a repository (looksLikeGitDir) at snapshot time; absent in older manifests. */
  root_git?: boolean;
  truncated: boolean;
  finalized: boolean;
  summary?: ProtectedSummary;
}

function under(rel: string, list: readonly string[]): boolean {
  const key = caseFold(rel);
  return list.some((p) => key === caseFold(p) || key.startsWith(caseFold(p) + '/'));
}

/**
 * A test for "acting on `rel` stays inside `root`". A job may replace an ordinary parent directory
 * with a symlink or junction; scanning or restoring through it would read and change files outside
 * the workdir, unsandboxed. Links that resolve inside the workdir stay protected. A missing parent is
 * created later as a real directory, so its nearest existing ancestor decides.
 */
function containment(root: string): (rel: string) => boolean {
  let realRoot: string | null = null;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    /* the workdir is gone: nothing can be restored into it */
  }
  const cache = new Map<string, boolean>();
  return (rel) => {
    if (realRoot === null) return false;
    const parent = path.dirname(path.join(root, rel));
    const known = cache.get(parent);
    if (known !== undefined) return known;
    let inside = false;
    for (let dir = parent; ;) {
      try {
        inside = within(fs.realpathSync.native(dir), realRoot);
        break;
      } catch (e) {
        const up = path.dirname(dir);
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || up === dir) break;
        dir = up;
      }
    }
    cache.set(parent, inside);
    return inside;
  };
}

function sha(file: string): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

function entryOf(root: string, rel: string): Entry | null {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    let link = '';
    try {
      link = fs.readlinkSync(abs);
    } catch {
      /* ignore */
    }
    return { rel, type: 'symlink', mode: st.mode & 0o7777, size: 0, link };
  }
  if (st.isDirectory()) return { rel, type: 'dir', mode: st.mode & 0o7777, size: 0 };
  if (st.isFile()) return { rel, type: 'file', mode: st.mode & 0o7777, size: st.size, sha: st.size <= 64 * MAX_COPY ? sha(abs) : undefined };
  return { rel, type: 'other', mode: st.mode & 0o7777, size: 0 };
}

/**
 * Walk the protected roots of `root` plus `watch` without following symlinks. Recursion only enters
 * real directories; a starting point whose parent resolves outside `root` is skipped.
 */
export function scanProtected(root: string, watch: readonly string[] = []): { entries: Entry[]; truncated: boolean } {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const inside = containment(root);
  let truncated = false;
  const start = (rel: string): void => {
    if (inside(rel)) visit(rel);
  };
  const visit = (rel: string): void => {
    if (seen.has(caseFold(rel)) || under(rel, PROTECTED_IGNORE)) return;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    seen.add(caseFold(rel));
    const e = entryOf(root, rel);
    if (!e) return;
    entries.push(e);
    if (e.type === 'dir') {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(root, rel)).sort();
      } catch {
        return;
      }
      for (const n of names) visit(`${rel}/${n}`);
    }
  };
  // Single files first, so a huge protected directory cannot push them past the entry limit.
  for (const f of PROTECTED_FILES) start(f);
  for (const d of PROTECTED_DIRS) start(d);
  for (const w of watch) start(w);
  return { entries, truncated };
}

/** Directory inside a job directory where protected-file snapshots, replaced versions and quarantined files live. */
export const PROTECT_DIR = 'protect';

function manifestPath(jobDir: string): string {
  return path.join(jobDir, PROTECT_DIR, 'manifest.json');
}

/** Snapshot protected config before a write job. `git` comes from gitLayout() taken at the same time. */
export function snapshot(root: string, jobDir: string, git?: { watch: string[]; entries: string[]; complete: boolean }): void {
  const base = path.join(jobDir, PROTECT_DIR);
  ensureDir0700(path.join(base, 'before'));
  const watch = git?.watch ?? [];
  const { entries, truncated } = scanProtected(root, watch);
  let copied = 0;
  for (const e of entries) {
    if (e.type !== 'file' || e.size > MAX_COPY || copied + e.size > MAX_TOTAL_COPY) continue;
    const dst = path.join(base, 'before', e.rel);
    try {
      ensureDir0700(path.dirname(dst));
      fs.copyFileSync(path.join(root, e.rel), dst);
      fs.chmodSync(dst, 0o600);
      e.copied = true;
      copied += e.size;
    } catch {
      /* unrestorable later */
    }
  }
  const g = git ?? (() => {
    const f = findGitEntries(root);
    return { entries: f.rels, complete: f.complete };
  })();
  const m: Manifest = {
    snapshotted_at_ms: Date.now(), root, entries, watch, existing_git: g.entries, git_complete: g.complete, root_git: looksLikeGitDir(root), truncated, finalized: false,
  };
  writeJsonAtomic(manifestPath(jobDir), m);
}

function same(a: Entry, b: Entry): boolean {
  return a.type === b.type && a.mode === b.mode && a.size === b.size && a.sha === b.sha && a.link === b.link;
}

/** An empty read-only file a Linux sandbox (bubblewrap) mounted over a missing protected path. */
function isPlaceholderFile(e: Entry): boolean {
  return e.type === 'file' && e.size === 0 && (e.mode & 0o777) === 0o444;
}

function freeName(p: string): string {
  if (!fs.existsSync(p)) return p;
  for (let i = 1; ; i++) if (!fs.existsSync(`${p}.${i}`)) return `${p}.${i}`;
}

/**
 * Move a path out of the workdir into the job's archive (`protect/<sub>/<rel>`). Rename when possible;
 * across filesystems copy first and delete the original only after the copy succeeded. Never a size cap.
 * Returns the archive path relative to the job dir, or undefined (and the original is left in place).
 */
function moveAside(root: string, jobDir: string, rel: string, sub: 'after' | 'quarantine'): string | undefined {
  const src = path.join(root, rel);
  const dst = freeName(path.join(jobDir, PROTECT_DIR, sub, rel));
  try {
    ensureDir0700(path.dirname(dst));
  } catch {
    return undefined;
  }
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') return undefined;
    try {
      const st = fs.lstatSync(src);
      if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
      else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
      else if (st.isFile()) fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      else return undefined;
      fs.rmSync(src, { recursive: true, force: true });
    } catch {
      return undefined;
    }
  }
  try {
    if (fs.lstatSync(dst).isFile()) fs.chmodSync(dst, 0o600);
  } catch {
    /* ignore */
  }
  return path.relative(jobDir, dst).split(path.sep).join('/');
}

function isEmptyDir(abs: string): boolean {
  try {
    return fs.readdirSync(abs).length === 0;
  } catch {
    return false;
  }
}

/**
 * After a write job: put protected config back as it was before the job and quarantine newly planted
 * `.git` entries. It cannot tell who made a change (the sub-agent, the user, the host app or an IDE),
 * so nothing is ever destroyed: every version it replaces or removes is first moved into the job's
 * archive, host/IDE-managed paths are only reported, and an incomplete scan only reports.
 * Empty placeholders left by sandboxes are removed silently. Idempotent (runner, reaper, force-cancel).
 */
export function finalizeProtect(jobDir: string, policy: 'revert' | 'report'): ProtectedSummary | null {
  const m = readJsonSafe<Manifest>(manifestPath(jobDir));
  if (!m) {
    // No snapshot means nothing to restore. A snapshot that was started (its directory exists) but
    // cannot be read, or whose manifest is gone, is not that.
    if (fs.existsSync(path.join(jobDir, PROTECT_DIR))) throw new Error('protected-file manifest cannot be read');
    return null;
  }
  if (m.finalized && m.summary) return m.summary;
  const root = m.root;
  const watch = m.watch ?? [];
  const items: ProtectedItem[] = [];
  const before = new Map(m.entries.map((e) => [caseFold(e.rel), e]));
  const inside = containment(root);
  // CLI-managed scratch dirs (Claude's .claude/.cc-writes) inside a protected dir that did not exist
  // before: drop them while empty, so their parent reads as the placeholder it is.
  for (const p of PROTECTED_IGNORE) {
    const parent = path.dirname(p);
    if (before.has(caseFold(parent)) || !inside(p)) continue;
    const abs = path.join(root, p);
    if (isEmptyDir(abs)) {
      try {
        fs.rmdirSync(abs);
      } catch {
        /* keep */
      }
    }
  }
  const now = scanProtected(root, watch);
  const current = new Map(now.entries.map((e) => [caseFold(e.rel), e]));
  const truncated = m.truncated || now.truncated;
  const act = policy === 'revert';
  const revertible = (rel: string): boolean => act && !under(rel, PROTECTED_REPORT_ONLY);

  // New entries (deepest first so directories empty out before their parents).
  const added = now.entries.filter((e) => !before.has(caseFold(e.rel))).sort((a, b) => b.rel.length - a.rel.length);
  const addedChild = (rel: string): boolean => added.some((x) => x.rel.startsWith(rel + '/'));
  for (const e of added) {
    const abs = path.join(root, e.rel);
    if (e.type === 'dir') {
      // Empty new dirs lose nothing when removed (sandbox mount points, or emptied below).
      if (isEmptyDir(abs) && (revertible(e.rel) || !addedChild(e.rel))) {
        try {
          fs.rmdirSync(abs);
          if (!addedChild(e.rel)) items.push({ path: e.rel, action: 'placeholder_removed' });
        } catch {
          items.push({ path: e.rel, action: 'reported' });
        }
      } else if (!revertible(e.rel) && !addedChild(e.rel)) {
        items.push({ path: e.rel, action: 'reported' });
      }
      continue;
    }
    if (isPlaceholderFile(e)) {
      try {
        fs.unlinkSync(abs);
        items.push({ path: e.rel, action: 'placeholder_removed' });
      } catch {
        items.push({ path: e.rel, action: 'reported' });
      }
      continue;
    }
    if (!revertible(e.rel) || truncated) {
      items.push({ path: e.rel, action: 'reported' });
      continue;
    }
    const saved = moveAside(root, jobDir, e.rel, 'after');
    items.push(saved ? { path: e.rel, action: 'removed', saved_as: saved } : { path: e.rel, action: 'reported' });
  }
  // Changed or deleted entries. A path missing from a truncated scan is looked up directly.
  for (const b of m.entries) {
    if (!inside(b.rel)) {
      // A parent now leads out of the workdir: the original cannot be put back without writing there.
      items.push({ path: b.rel, action: 'unrestorable' });
      continue;
    }
    const c = current.get(caseFold(b.rel)) ?? entryOf(root, b.rel);
    if (c && same(b, c)) continue;
    const abs = path.join(root, b.rel);
    if (b.type === 'dir') {
      if (!revertible(b.rel)) {
        if (!c) items.push({ path: b.rel, action: 'reported' });
        continue;
      }
      if (!c) {
        try {
          fs.mkdirSync(abs, { recursive: true, mode: b.mode });
          items.push({ path: b.rel, action: 'restored' });
        } catch {
          items.push({ path: b.rel, action: 'unrestorable' });
        }
      } else if (c.type === 'dir' && c.mode !== b.mode) {
        try {
          fs.chmodSync(abs, b.mode);
          items.push({ path: b.rel, action: 'reverted' });
        } catch {
          items.push({ path: b.rel, action: 'unrestorable' });
        }
      } else if (c.type !== 'dir') {
        items.push({ path: b.rel, action: 'unrestorable' });
      }
      continue;
    }
    if (!revertible(b.rel)) {
      items.push({ path: b.rel, action: 'reported' });
      continue;
    }
    const canRestore = (b.type === 'file' && b.copied) || (b.type === 'symlink' && b.link !== undefined);
    if (!canRestore) {
      // No copy of the original (too large, unreadable or special): leave the current version alone.
      items.push({ path: b.rel, action: 'unrestorable' });
      continue;
    }
    let saved: string | undefined;
    if (c) {
      saved = moveAside(root, jobDir, b.rel, 'after');
      if (!saved) {
        items.push({ path: b.rel, action: 'unrestorable' });
        continue;
      }
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (b.type === 'file') {
        fs.copyFileSync(path.join(jobDir, PROTECT_DIR, 'before', b.rel), abs);
        fs.chmodSync(abs, b.mode);
      } else {
        fs.symlinkSync(b.link!, abs);
      }
      items.push({ path: b.rel, action: c ? 'reverted' : 'restored', ...(saved ? { saved_as: saved } : {}) });
    } catch {
      items.push({ path: b.rel, action: 'unrestorable', ...(saved ? { saved_as: saved } : {}) });
    }
  }
  // Newly planted .git entries anywhere under the workdir (only trusted when the first walk was complete).
  const git = findGitEntries(root);
  const known = new Set(m.existing_git);
  const quarantine = (rel: string): void => {
    if (!act || m.git_complete === false) {
      items.push({ path: rel, action: 'reported' });
      return;
    }
    const q = moveAside(root, jobDir, rel, 'quarantine');
    items.push(q ? { path: rel, action: 'quarantined', saved_as: q } : { path: rel, action: 'reported' });
  };
  for (const rel of git.rels) {
    if (known.has(rel)) continue;
    // A repository dir named otherwise may be the user's own dir the job only added HEAD and objects/refs to:
    // moving its HEAD aside is enough for git to stop accepting it, and leaves the rest in place.
    const target = caseFold(path.posix.basename(rel)) === '.git' ? rel : `${rel}/HEAD`;
    if (!inside(target)) {
      items.push({ path: target, action: 'reported' });
      continue;
    }
    if (target !== rel) {
      quarantine(target);
      continue;
    }
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory() && isEmptyDir(abs)) {
      try {
        fs.rmdirSync(abs);
        items.push({ path: rel, action: 'placeholder_removed' });
      } catch {
        items.push({ path: rel, action: 'reported' });
      }
      continue;
    }
    if (st.isFile() && st.size === 0 && (st.mode & 0o777) === 0o444) {
      try {
        fs.unlinkSync(abs);
        items.push({ path: rel, action: 'placeholder_removed' });
      } catch {
        items.push({ path: rel, action: 'reported' });
      }
      continue;
    }
    quarantine(rel);
  }
  // The workdir itself made a repository: where its own `.git` is missing or broken (git_write can rewrite
  // .git/HEAD), git run anywhere inside it would use the planted config and hooks.
  if (m.root_git === false && looksLikeGitDir(root)) quarantine('HEAD');
  const summary: ProtectedSummary = { items, policy, scan_complete: !truncated && git.complete && m.git_complete !== false };
  writeJsonAtomic(manifestPath(jobDir), { ...m, finalized: true, summary });
  return summary;
}

const PLACEHOLDER_CANDIDATES = METADATA_DIRS;

/** Which top-level metadata dirs exist before a read job (for placeholder cleanup afterwards). */
export function topLevelState(root: string): string[] {
  return PLACEHOLDER_CANDIDATES.filter((n) => {
    try {
      fs.lstatSync(path.join(root, n));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * After a read job: remove empty metadata dirs that did not exist before — Linux sandboxes leave
 * mount-point placeholders (e.g. `.git`, `.codex`) and Claude creates `.claude/.cc-writes/` itself.
 */
export function cleanupPlaceholders(root: string, existedBefore: string[]): string[] {
  const removed: string[] = [];
  for (const n of PLACEHOLDER_CANDIDATES) {
    if (existedBefore.includes(n)) continue;
    const dir = path.join(root, n);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory()) continue;
      if (n === '.claude') {
        const cc = path.join(dir, '.cc-writes');
        if (isEmptyDir(cc)) fs.rmdirSync(cc);
      }
      if (isEmptyDir(dir)) {
        fs.rmdirSync(dir);
        removed.push(n);
      }
    } catch {
      /* nothing to do */
    }
  }
  return removed;
}
