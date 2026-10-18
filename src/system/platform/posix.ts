import { spawnSync } from 'node:child_process';

export type Liveness = 'alive' | 'dead' | 'unknown';

const PS_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };

function killZero(pid: number): 'exists' | 'gone' {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (e) {
    // ESRCH: no such process. EPERM: exists but belongs to another user => a reused pid, not ours.
    return 'gone';
  }
}

/**
 * Tri-state liveness of one of our processes, identified by pid AND a marker string that must
 * appear in its command line (defeats pid reuse). "unknown" must never be treated as dead.
 */
export function probe(pid: number, marker: string): Liveness {
  if (!Number.isInteger(pid) || pid <= 1) return 'dead';
  if (killZero(pid) === 'gone') return 'dead';
  const r = spawnSync('ps', ['-ww', '-o', 'stat=,command=', '-p', String(pid)], { env: PS_ENV, encoding: 'utf8', timeout: 3000 });
  if (r.error || r.signal) return 'unknown';
  const line = (r.stdout ?? '').trim();
  if (r.status === 0 && line) {
    const stat = line.split(/\s+/, 1)[0] ?? '';
    if (stat.startsWith('Z')) return 'dead';
    return line.includes(marker) ? 'alive' : 'dead';
  }
  if (r.status === 1 && !line) return killZero(pid) === 'gone' ? 'dead' : 'unknown';
  return 'unknown';
}

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

function snapshot(): PsRow[] | null {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { env: PS_ENV, encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return null;
  const rows: PsRow[] = [];
  for (const l of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(l);
    if (m) rows.push({ pid: +m[1]!, ppid: +m[2]!, pgid: +m[3]! });
  }
  return rows;
}

/** All descendants of `roots` (by ppid) plus every member of the given process groups. */
export function descendants(roots: number[], groups: number[] = []): number[] {
  const rows = snapshot();
  if (!rows) return [];
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const p = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === p && !out.has(r.pid)) {
        out.add(r.pid);
        queue.push(r.pid);
      }
    }
  }
  for (const r of rows) if (groups.includes(r.pgid)) out.add(r.pid);
  for (const r of roots) out.delete(r);
  out.delete(process.pid);
  return [...out];
}

export function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      /* gone */
    }
  }
}

export function isGone(pid: number): boolean {
  return killZero(pid) === 'gone';
}

/** ps-based ancestor walk: returns the command lines of all ancestors (≤64 hops) or null on failure. */
export function ancestorCommands(): string[] | null {
  const r = spawnSync('ps', ['-ww', '-A', '-o', 'pid=,ppid=,args='], { env: PS_ENV, encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  const map = new Map<number, { ppid: number; args: string }>();
  for (const l of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) map.set(+m[1]!, { ppid: +m[2]!, args: m[3]! });
  }
  const out: string[] = [];
  let cur = process.ppid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const row = map.get(cur);
    if (!row) break;
    out.push(row.args);
    cur = row.ppid;
  }
  return out;
}
