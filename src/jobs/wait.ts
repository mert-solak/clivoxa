import type { Config, Layout } from '../config/config.js';
import { sleep } from '../system/fs.js';
import { isFinished } from './store.js';
import { computeStatus } from './status.js';
import type { JobView } from '../domain/job.js';

/**
 * Wait until the job finishes or `waitS` elapses (measured from `startMs`). Aborting the wait never
 * cancels the job. Calls `onTick(elapsedS)` about every 10 s (used for MCP progress notifications).
 */
export async function waitForJob(
  cfg: Config,
  lay: Layout,
  dir: string,
  waitS: number,
  startMs: number,
  signal: AbortSignal | undefined,
  onTick?: (elapsedS: number) => void,
): Promise<JobView | null> {
  const deadline = startMs + Math.min(waitS, cfg.maxWaitS) * 1000;
  let lastStatus = Date.now();
  let lastTick = Date.now();
  while (Date.now() < deadline && !signal?.aborted) {
    if (isFinished(dir)) break;
    const now = Date.now();
    if (now - lastStatus >= 5000) {
      lastStatus = now;
      const v = computeStatus(cfg, lay, dir, { reap: true });
      if (v && v.status !== 'running') return v;
    }
    if (onTick && now - lastTick >= 10_000) {
      lastTick = now;
      try {
        onTick(Math.round((now - startMs) / 1000));
      } catch {
        /* ignore */
      }
    }
    await sleep(Math.min(cfg.pollMs, Math.max(10, deadline - Date.now())), signal);
  }
  return computeStatus(cfg, lay, dir, { reap: true });
}
