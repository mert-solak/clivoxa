import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, Layout } from '../config/config.js';
import { askToolName, type Target } from '../domain/ids.js';
import { ensureDir0700, exists } from '../system/fs.js';
import { resolveJobDir, isFinished, JobFiles } from '../jobs/store.js';
import { computeStatus } from '../jobs/status.js';
import type { IsActive } from '../jobs/locks.js';
import { msg } from '../shared/messages.js';

/** What every tool handler needs: configuration, on-disk layout and the counterpart it runs. */
export interface ToolContext {
  cfg: Config;
  lay: Layout;
  target: Target;
}

/** The parts of the MCP request context the handlers use. */
export interface ToolExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number; [k: string]: unknown };
  sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
  requestInfo?: unknown;
}

export function textResult(t: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

/** A refused call, rendered in the same block format as job results. */
export function refused(t: string): CallToolResult {
  return textResult(`[clivoxa]\nstatus: refused\nerror: ${t}`, true);
}

/** The requested wait, clamped to the configured ceiling (noting a clamp in `notes`). */
export function clampWait(cfg: Config, v: number | undefined, notes: string[]): number {
  if (v === undefined) return cfg.defaultWaitS;
  const n = Math.floor(v);
  if (n > cfg.maxWaitS) notes.push(msg('wait_clamped', { max: cfg.maxWaitS }));
  return Math.max(0, Math.min(cfg.maxWaitS, n));
}

/** Lock-ownership check: a job holds its locks while it is still running. */
export function jobActivity(ctx: ToolContext): IsActive {
  return (jobId: string) => {
    const dir = resolveJobDir(jobsDirectory(ctx), jobId);
    if (!dir) return 'finished';
    if (isFinished(dir)) return 'finished';
    const v = computeStatus(ctx.cfg, ctx.lay, dir, { reap: true });
    // Only a missing request means no job; one that exists but cannot be read (held open by a scanner, EMFILE) may be live.
    if (!v) return exists(path.join(dir, JobFiles.request)) ? 'unknown' : 'finished';
    return v.status === 'running' ? 'active' : 'finished';
  };
}

/** The canonical jobs directory (created on first use). */
export function jobsDirectory(ctx: ToolContext): string {
  ensureDir0700(ctx.lay.jobs);
  return fs.realpathSync.native(ctx.lay.jobs);
}

/** Progress notifications for long waits, when the client asked for them. */
export function progressReporter(extra: ToolExtra): ((s: number) => void) | undefined {
  const tok = extra._meta?.progressToken;
  if (tok === undefined || !extra.sendNotification) return undefined;
  return (s: number) => {
    void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: tok, progress: s, message: `çalışıyor (${s} sn)` } }).catch(() => undefined);
  };
}

export function renderOptions(ctx: ToolContext, notes: string[], answerOffset = 0) {
  return { answerOffset, maxChars: ctx.cfg.maxAnswerChars, notes, secretPolicyOff: ctx.cfg.secretPolicy === 'off', askTool: askToolName(ctx.target) };
}
