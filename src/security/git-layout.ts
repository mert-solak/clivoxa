import fs from 'node:fs';
import path from 'node:path';
import { isWithin, caseFold } from '../system/paths.js';

const WALK_MAX = 300_000;
const WALK_MS = 10_000;
const MAX_GIT_DIRS = 2000;

/** Entries inside any git dir whose change makes git run code (hooks, config drivers) or follow a redirect. */
export const GIT_INTERNALS = ['hooks', 'info', 'config', 'commondir', 'config.worktree'];
/** The top-level repo's internals kept read-only under git_write when no layout was computed. */
export const TOP_GIT_READ_ONLY = ['.git/hooks', '.git/config', '.git/info'];

export interface GitLayout {
  /** `.git` entries (dirs, files or symlinks) and repository dirs named otherwise, relative; includes the top-level one. */
  entries: string[];
  /** Git dirs inside the workdir, relative: `.git` dirs, in-workdir gitdir targets, submodule and worktree admin dirs. */
  gitDirs: string[];
  /** `.git` pointer files/symlinks, relative (changing one redirects git to another dir). */
  pointers: string[];
  /** The top-level `.git` is a real directory (the workdir's own repository). */
  topIsDir: boolean;
  /** False when the walk hit its size/time limit (unseen repositories cannot be protected). */
  complete: boolean;
}

/**
 * A directory git accepts as a repository whatever its name (setup.c is_git_directory): a HEAD that is not a
 * directory (a dangling `refs/...` symlink counts), and `objects` plus `refs` of any type (Git for Windows ignores
 * X_OK) or a `commondir` that moves them elsewhere. Over-approximates on purpose; never follows a link.
 */
export function looksLikeGitDir(abs: string): boolean {
  const lstat = (name: string): fs.Stats | null => {
    try {
      return fs.lstatSync(path.join(abs, name));
    } catch {
      return null;
    }
  };
  const head = lstat('HEAD');
  if (!head || head.isDirectory()) return false;
  return !!lstat('commondir') || (!!lstat('objects') && !!lstat('refs'));
}

/**
 * Find `.git` entries and repository dirs named otherwise (looksLikeGitDir) anywhere under root
 * (no symlink following; does not descend into node_modules or .git dirs).
 */
export function findGitEntries(root: string): { rels: string[]; complete: boolean } {
  const out: string[] = [];
  const t0 = Date.now();
  let n = 0;
  let complete = true;
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(path.join(root, rel));
    } catch {
      continue;
    }
    try {
      for (let d = dir.readSync(); d; d = dir.readSync()) {
        if (++n > WALK_MAX || Date.now() - t0 > WALK_MS) {
          complete = false;
          break;
        }
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (caseFold(d.name) === '.git') {
          out.push(r);
          continue;
        }
        if (d.isDirectory() && !d.isSymbolicLink()) {
          // A repository need not be named `.git`: a bare repo, or an ordinary dir a write job armed with plain
          // writes. It is still walked, since it may be the user's own dir with more repositories inside.
          if (looksLikeGitDir(path.join(root, r))) out.push(r);
          if (d.name !== 'node_modules') stack.push(r);
        }
      }
    } finally {
      dir.closeSync();
    }
    if (!complete) break;
  }
  return { rels: out.sort(), complete };
}

function relIn(rootReal: string, abs: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return null;
  }
  if (real === rootReal || !isWithin(real, rootReal)) return null;
  return path.relative(rootReal, real).split(path.sep).join('/');
}

/** Where a `.git` file (`gitdir: <path>`) or symlink points. */
function pointerTarget(abs: string): string | null {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return fs.realpathSync.native(abs);
    if (!st.isFile() || st.size > 4096) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(abs, 'utf8'));
    return m ? path.resolve(path.dirname(abs), m[1]!) : null;
  } catch {
    return null;
  }
}

function isFile(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Submodule (`modules/**` with a HEAD) and worktree (`worktrees/*`) admin dirs under a git dir. */
function adminDirs(root: string, gitRel: string, add: (rel: string) => boolean): void {
  const walk = (rel: string, depth: number): void => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, rel));
    } catch {
      return;
    }
    for (const n of names) {
      const r = `${rel}/${n}`;
      const abs = path.join(root, r);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (isFile(path.join(abs, 'HEAD'))) {
        if (add(r)) adminDirs(root, r, add);
      } else walk(r, depth + 1);
    }
  };
  walk(`${gitRel}/modules`, 0);
  try {
    for (const n of fs.readdirSync(path.join(root, gitRel, 'worktrees'))) {
      const r = `${gitRel}/worktrees/${n}`;
      try {
        if (fs.lstatSync(path.join(root, r)).isDirectory()) add(r);
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* no worktrees */
  }
}

/** Every git repository under a workdir that a write job must not be able to arm (hooks, config, redirects). */
export function gitLayout(root: string): GitLayout {
  const rootReal = fs.realpathSync.native(root);
  const found = findGitEntries(rootReal);
  let complete = found.complete;
  const gitDirs = new Set<string>();
  const pointers: string[] = [];
  const add = (rel: string): boolean => {
    if (gitDirs.has(rel)) return false;
    if (gitDirs.size >= MAX_GIT_DIRS) {
      complete = false;
      return false;
    }
    gitDirs.add(rel);
    return true;
  };
  let topIsDir = false;
  for (const rel of found.rels) {
    const abs = path.join(rootReal, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (caseFold(rel) === '.git') topIsDir = true;
      add(rel);
      continue;
    }
    pointers.push(rel);
    const target = pointerTarget(abs);
    if (!target) continue;
    const t = relIn(rootReal, target);
    if (t) add(t);
    // A linked worktree's admin dir names its common dir; protect that too when it lives inside the workdir.
    try {
      const common = fs.readFileSync(path.join(target, 'commondir'), 'utf8').trim();
      const c = common ? relIn(rootReal, path.resolve(target, common)) : null;
      if (c) add(c);
    } catch {
      /* not a linked worktree */
    }
  }
  for (const g of [...gitDirs]) adminDirs(rootReal, g, add);
  return { entries: found.rels, gitDirs: [...gitDirs].sort(), pointers: pointers.sort(), topIsDir, complete };
}

/** Paths (relative) the post-job backstop scan watches: git internals of every git dir and every pointer. */
export function gitWatchRels(l: GitLayout): string[] {
  const out = new Set<string>(l.pointers);
  for (const g of l.gitDirs) for (const i of GIT_INTERNALS) out.add(`${g}/${i}`);
  return [...out].sort();
}

function under(rel: string, parent: string): boolean {
  return rel === parent || rel.startsWith(parent + '/');
}

/**
 * Paths (relative) a write job's sandbox must keep read-only, beyond the top-level `.git` rule:
 * - nested repositories (and in-workdir gitdir targets) entirely, even with git_write (it is for the workdir's own repo);
 * - with git_write and a real top-level `.git` dir: its internals, `modules/` and `worktrees/`.
 * Missing paths are listed only where the sandbox can deny creating them without leaving a placeholder
 * (macOS Seatbelt). On Linux, bubblewrap mounts a placeholder at a missing path, which would break git
 * (an empty `.git/commondir` makes every git command fail); the post-job scan still catches creation there.
 */
export function gitReadOnly(root: string, l: GitLayout, gitWrite: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const out = new Set<string>();
  const ok = (rel: string): boolean => platform === 'darwin' || fs.existsSync(path.join(root, rel));
  for (const e of l.entries) if (e !== '.git') out.add(e);
  for (const g of l.gitDirs) {
    if (g === '.git' || l.entries.some((e) => e !== '.git' && under(g, e))) continue;
    if (!under(g, '.git')) out.add(g);
    else if (gitWrite && l.topIsDir && !under(g, '.git/modules') && !under(g, '.git/worktrees')) out.add(g);
  }
  if (gitWrite && l.topIsDir) {
    for (const r of [...GIT_INTERNALS.map((i) => `.git/${i}`), '.git/modules', '.git/worktrees']) if (ok(r)) out.add(r);
  }
  return [...out].sort();
}
