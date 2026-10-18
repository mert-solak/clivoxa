import path from 'node:path';
import { readJsonSafe, writeJsonAtomic, ensureDir0700 } from '../system/fs.js';
import { targetFromName, type Target } from '../domain/ids.js';

export interface SessionIndex {
  session_id: string;
  target: Target;
  cwd: string;
  workdir: string | null;
  created_at: string;
  updated_at: string;
  jobs: string[];
  first_access: 'read' | 'write';
  last_access: 'read' | 'write';
  model: string;
  effort: string;
}

function file(sessionsDir: string, target: Target, sid: string): string {
  return path.join(sessionsDir, `${target}-${sid}.json`);
}

export function readSession(sessionsDir: string, target: Target, sid: string): SessionIndex | null {
  const s = readJsonSafe<Omit<SessionIndex, 'target'> & { target: string }>(file(sessionsDir, target, sid));
  return s && s.session_id === sid && targetFromName(s.target) === target ? { ...s, target } : null;
}

/** Record a session after a SUCCESSFUL attempt only. */
export function upsertSession(sessionsDir: string, s: Omit<SessionIndex, 'created_at' | 'updated_at' | 'jobs' | 'first_access'> & { job_id: string }): void {
  ensureDir0700(sessionsDir);
  const prev = readSession(sessionsDir, s.target, s.session_id);
  const now = new Date().toISOString();
  const next: SessionIndex = {
    session_id: s.session_id,
    target: s.target,
    cwd: prev?.cwd ?? s.cwd,
    workdir: prev ? prev.workdir : s.workdir,
    created_at: prev?.created_at ?? now,
    updated_at: now,
    jobs: [...new Set([...(prev?.jobs ?? []), s.job_id])],
    first_access: prev?.first_access ?? s.last_access,
    last_access: s.last_access,
    model: s.model,
    effort: s.effort,
  };
  writeJsonAtomic(file(sessionsDir, s.target, s.session_id), next);
}
