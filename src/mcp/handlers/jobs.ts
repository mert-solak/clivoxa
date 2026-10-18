import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jobTarget } from '../../domain/ids.js';
import { writeAtomic, sleep } from '../../system/fs.js';
import { resolveJobDir, JobFiles, isFinished, listJobDirs, readRequest, readRunner, runnerMarker } from '../../jobs/store.js';
import { abandonJob, computeStatus } from '../../jobs/status.js';
import { waitForJob } from '../../jobs/wait.js';
import { renderJob, renderJobList } from '../render.js';
import { msg } from '../../shared/messages.js';
import { cheapGuards } from '../../security/guards.js';
import { probe } from '../../system/platform/index.js';
import { type ToolContext, type ToolExtra, textResult, refused, clampWait, jobsDirectory, progressReporter, renderOptions } from '../context.js';

function jobDirFor(ctx: ToolContext, jobId: string): string | CallToolResult {
  const t = jobTarget(jobId);
  if (!t) return refused(msg('job_not_found', { job_id: jobId }));
  if (t !== ctx.target) return refused(msg('role_mismatch', { job_id: jobId, target: ctx.target }));
  const dir = resolveJobDir(jobsDirectory(ctx), jobId);
  if (!dir) return refused(msg('job_not_found', { job_id: jobId }));
  return dir;
}

export async function handleGetJob(ctx: ToolContext, a: { job_id: string; wait_seconds?: number; answer_offset?: number }, extra: ToolExtra): Promise<CallToolResult> {
  const g = cheapGuards(ctx.cfg);
  if (g) return refused(msg('guard_refused', { reason: g }));
  const notes: string[] = [];
  const startMs = Date.now();
  const waitS = clampWait(ctx.cfg, a.wait_seconds, notes);
  const dir = jobDirFor(ctx, a.job_id);
  if (typeof dir !== 'string') return dir;
  let v = computeStatus(ctx.cfg, ctx.lay, dir, { reap: true });
  if (v && v.status === 'running' && waitS > 0) v = await waitForJob(ctx.cfg, ctx.lay, dir, waitS, startMs, extra.signal, progressReporter(extra));
  if (!v) return refused(msg('job_not_found', { job_id: a.job_id }));
  return textResult(renderJob(v, renderOptions(ctx, notes, a.answer_offset ?? 0)));
}

export function handleListJobs(ctx: ToolContext, a: { limit?: number }): CallToolResult {
  const g = cheapGuards(ctx.cfg);
  if (g) return refused(msg('guard_refused', { reason: g }));
  const raw = a.limit ?? 20;
  const limit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(raw) ? raw : 20)));
  const rows = [];
  for (const dir of listJobDirs(ctx.lay, ctx.target, limit)) {
    // Reaping here too: a job whose runner died is shown (and unlocked) as orphaned, not "running" forever.
    const v = computeStatus(ctx.cfg, ctx.lay, dir, { reap: true });
    if (!v) continue;
    rows.push({ job_id: v.job_id, status: v.status, elapsed_s: v.elapsed_s, effort: v.request.effort, access: v.request.access, workdir: v.request.workdir, label: v.request.label, session_id: v.meta?.session_id ?? null, preview: v.request.prompt_preview });
  }
  const out = renderJobList(rows);
  return textResult(raw !== limit ? `${out}\nnotes: ${msg('limit_clamped')}` : out);
}

export async function handleCancelJob(ctx: ToolContext, a: { job_id: string }): Promise<CallToolResult> {
  const g = cheapGuards(ctx.cfg);
  if (g) return refused(msg('guard_refused', { reason: g }));
  const dir = jobDirFor(ctx, a.job_id);
  if (typeof dir !== 'string') return dir;
  if (!isFinished(dir)) {
    writeAtomic(path.join(dir, JobFiles.cancelRequested), new Date().toISOString() + '\n');
    const runner = readRunner(dir);
    if (runner) {
      const l = probe(runner.pid, runnerMarker(runner, dir));
      if (l === 'alive') {
        try {
          if (process.platform !== 'win32') process.kill(runner.pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
        const t0 = Date.now();
        while (Date.now() - t0 < 3000 && !isFinished(dir)) await sleep(100);
      } else if (l === 'dead') {
        try {
          forceCancel(ctx, dir);
        } catch {
          // The restore cancel_job requires failed: the job stays unfinished, and its recovery block keeps the workdir closed.
          return refused(msg('protect_restore_failed'));
        }
      }
    }
  }
  const v = computeStatus(ctx.cfg, ctx.lay, dir, { reap: true });
  if (!v) return refused(msg('job_not_found', { job_id: a.job_id }));
  const notes = v.status === 'running' ? [msg('cancel_pending')] : [];
  return textResult(renderJob(v, renderOptions(ctx, notes)));
}

/** Runner is dead and the job unfinished: stop the identity-verified child tree and finalize as cancelled. */
function forceCancel(ctx: ToolContext, dir: string): void {
  const req = readRequest(dir);
  if (!req || isFinished(dir)) return;
  abandonJob(ctx.cfg, ctx.lay, dir, req, { kind: 'cancelled', message: msg('cancelled'), by: 'cancel', exitCode: 130, protection: 'required' });
}
