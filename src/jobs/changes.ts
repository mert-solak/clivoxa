import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { EXECUTABLE_SURFACES } from '../security/policy.js';
import type { ChangesSummary } from '../domain/job.js';
import { CONTENT_CONFIG, runHardenedGit, type GitResult } from '../security/git.js';

const WALK_MAX = 300_000;
const WALK_MS = 10_000;

interface GitSnap {
  head: string | null;
  status: { path: string; status: string }[];
}

export interface ChangesBefore {
  startMs: number;
  git: GitSnap | null;
  gitAllowed: boolean;
  note?: string;
}

function git(cfg: Config, cwd: string, args: string[]): GitResult {
  return runHardenedGit(cfg, cwd, args, { config: CONTENT_CONFIG, maxBuffer: 64 * 1024 * 1024 });
}

/** Refuse to run git if repo-local config defines drivers that `git status` could execute. */
export function gitSafe(cfg: Config, cwd: string): boolean {
  for (const scope of ['--local', '--worktree']) {
    const r = git(cfg, cwd, ['config', scope, '--includes', '--get-regexp', '^(filter|diff|merge)\\.']);
    if (r.out.trim()) return false;
  }
  return true;
}

function snap(cfg: Config, cwd: string): GitSnap | null {
  const top = git(cfg, cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const head = git(cfg, cwd, ['rev-parse', 'HEAD']);
  const st = git(cfg, cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  const status: { path: string; status: string }[] = [];
  if (st.ok) {
    for (const rec of st.out.split('\0')) {
      if (rec.length < 4) continue;
      status.push({ status: rec.slice(0, 2).trim() || '?', path: rec.slice(3) });
    }
  }
  return { head: head.ok ? head.out.trim() : null, status };
}

export function changesBefore(cfg: Config, cwd: string): ChangesBefore {
  const startMs = Date.now() - 1000;
  if (!cfg.bins.git) return { startMs, git: null, gitAllowed: false, note: 'git yok; yalnız dosya taraması' };
  if (!gitSafe(cfg, cwd)) return { startMs, git: null, gitAllowed: false, note: 'depo yerel git sürücüleri tanımlı; git çalıştırılmadı' };
  return { startMs, git: snap(cfg, cwd), gitAllowed: true };
}

function walkTouched(root: string, sinceMs: number): { files: string[]; complete: boolean } {
  const out: string[] = [];
  const t0 = Date.now();
  let n = 0;
  let complete = true;
  const stack = [''];
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
        if (d.isDirectory() && !d.isSymbolicLink()) {
          if (d.name === '.git' || d.name === 'node_modules') continue;
          stack.push(r);
          continue;
        }
        try {
          const st = fs.lstatSync(path.join(root, r));
          if (Math.max(st.mtimeMs, st.ctimeMs) >= sinceMs) out.push(r);
        } catch {
          /* vanished */
        }
      }
    } finally {
      dir.closeSync();
    }
    if (!complete) break;
  }
  return { files: out.sort(), complete };
}

export function changesAfter(cfg: Config, cwd: string, b: ChangesBefore, fromEvents: string[]): ChangesSummary {
  const after = b.gitAllowed ? snap(cfg, cwd) : null;
  const walk = walkTouched(cwd, b.startMs);
  const beforeSet = new Map((b.git?.status ?? []).map((s) => [s.path, s.status]));
  const files: { path: string; status: string }[] = [];
  if (after) {
    for (const s of after.status) {
      if (beforeSet.get(s.path) === s.status && !walk.files.includes(s.path)) continue;
      files.push(s);
    }
  }
  const gitPaths = new Set((after?.status ?? []).map((s) => s.path));
  const touchedOther = walk.files.filter((f) => !gitPaths.has(f));
  if (!after) for (const f of walk.files) files.push({ path: f, status: 'M?' });
  const newCommits: string[] = [];
  if (after?.head && b.git?.head && after.head !== b.git.head) {
    const r = git(cfg, cwd, ['rev-list', '--max-count=50', `${b.git.head}..${after.head}`]);
    if (r.ok) newCommits.push(...r.out.split('\n').map((s) => s.trim().slice(0, 12)).filter(Boolean));
  }
  const all = [...new Set([...files.map((f) => f.path), ...touchedOther])];
  const exec = all.filter((p) => EXECUTABLE_SURFACES.some((re) => re.test(p)));
  const notes = [b.note, walk.complete ? undefined : 'tarama sınırı aşıldı'].filter(Boolean) as string[];
  return {
    git: !!after,
    files: files.slice(0, 200),
    more: Math.max(0, files.length - 200),
    touched_untracked_or_ignored: after ? touchedOther.slice(0, 100) : [],
    preexisting_dirty: (b.git?.status ?? []).map((s) => s.path).slice(0, 100),
    head_before: b.git?.head ?? null,
    head_after: after?.head ?? null,
    new_commits: newCommits,
    executable_surfaces: exec.slice(0, 50),
    from_events: [...new Set(fromEvents)].slice(0, 200),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}
