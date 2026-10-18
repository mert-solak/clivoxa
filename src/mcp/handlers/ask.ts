import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, Layout } from '../../config/config.js';
import { isJobOf, newJobId, newUuid, nonce, normalizeUuid } from '../../domain/ids.js';
import { ensureDir0700, readTextSafe, writeAtomic } from '../../system/fs.js';
import { WorkdirError, validateWorkdir } from '../../security/workspace.js';
import { resolveJobDir, JobFiles, readRequest, runningJobs, writeFinalOnce, writeMeta, writeRequest } from '../../jobs/store.js';
import { computeStatus, retryRestore } from '../../jobs/status.js';
import { caseFold } from '../../system/paths.js';
import { readSession } from '../../jobs/sessions.js';
import { redact } from '../../shared/redact.js';
import { collectProjectNotes, composePrompt } from '../../jobs/prompt.js';
import { acquireLocks, clearRestorePending, LockConflict, releaseLocks, RestorePending, restorePendingFile, settleRestores, writeJobsOn } from '../../jobs/locks.js';
import { spawnRunner } from '../../jobs/spawn.js';
import { waitForJob } from '../../jobs/wait.js';
import { renderJob } from '../render.js';
import { msg } from '../../shared/messages.js';
import { cheapGuards } from '../../security/guards.js';
import { runHardenedGit } from '../../security/git.js';
import { readSandboxRecord } from '../../providers/capabilities.js';
import { decideCodexSandbox } from '../../providers/codex/sandbox-plan.js';
import { packageRoot } from '../../system/entrypoints.js';
import { VERSION } from '../../shared/version.js';
import type { JobRequest, Meta, ReviewTarget, Web } from '../../domain/job.js';
import { reviewInstruction } from '../../providers/codex/review.js';
import { listModels, selectionValue } from '../../providers/models.js';
import { readClaudeRecord } from '../../providers/verification.js';
import { type ToolContext, type ToolExtra, textResult, refused, clampWait, jobActivity, jobsDirectory, progressReporter, renderOptions } from '../context.js';
import type { AskArgs } from '../schemas.js';

function sanitizeLabel(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t || null;
}

/** Why a review request cannot run as asked (Turkish), or null. */
export function reviewRefusal(
  t: ReviewTarget,
  o: { access: 'read' | 'write'; workdir: string | null; gitTop: string | null; session: boolean; shell?: boolean },
): string | null {
  if (o.access !== 'read') return "yalnız access='read' ile çalışır; düzeltmeleri incelemeden sonra ayrı bir istekle yaptırın.";
  if (o.session) return 'session_id ile kullanılamaz; inceleme her zaman yeni bir oturumdur.';
  if (!o.workdir) return 'workdir gerekli (incelenecek git deposu).';
  if (!o.gitTop) return 'workdir bir git deposu değil.';
  if (o.shell === false) return 'Codex değişiklikleri git ile okuduğu için kabuk gerekir (shell=false verilemez).';
  if (t.scope === 'uncommitted' && t.ref) return "ref yalnız 'base' ve 'commit' ile verilir.";
  if (t.scope !== 'uncommitted' && !t.ref) return `'${t.scope}' için ref gerekli (${t.scope === 'base' ? 'dal adı' : 'commit'}).`;
  return null;
}

/**
 * A review ref must name one commit: revision sets such as HEAD^@ or HEAD^- would silently widen the
 * review. A commit is pinned to its id; a base branch keeps its name once it resolves.
 */
export function resolveReviewRef(cfg: Config, workdir: string, t: ReviewTarget): { ref: string | null } | { reason: string } {
  if (!t.ref) return { ref: null };
  const resolved = runHardenedGit(cfg, workdir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${t.ref}^{commit}`]);
  const sha = resolved.out.trim();
  if (!resolved.ok || !/^[0-9a-f]{40,64}$/.test(sha)) return { reason: `ref tek bir commit'e çözülemedi (${t.ref}).` };
  return { ref: t.scope === 'commit' ? sha : t.ref };
}

function extractGorev(promptMd: string, n: string): string {
  const s = promptMd.indexOf(`<<<GOREV_${n}\n`);
  const e = promptMd.indexOf(`\nGOREV_${n}>>>`);
  if (s < 0 || e < 0) return '';
  return promptMd.slice(s + `<<<GOREV_${n}\n`.length, e);
}

function previousTurns(ctx: ToolContext, jobs: string[]): { label: string; prompt: string; answer: string }[] {
  const out: { label: string; prompt: string; answer: string }[] = [];
  let budget = 24 * 1024;
  for (const id of [...jobs].reverse()) {
    const dir = resolveJobDir(jobsDirectory(ctx), id);
    if (!dir) continue;
    const req = readRequest(dir);
    const ans = readTextSafe(path.join(dir, JobFiles.answer));
    const pm = readTextSafe(path.join(dir, JobFiles.prompt));
    if (!req || !ans || !pm) continue;
    const p = extractGorev(pm, req.nonce).slice(0, 6000);
    const a = ans.slice(0, 8000);
    if (p.length + a.length > budget) break;
    budget -= p.length + a.length;
    out.unshift({ label: `${id}${req.label ? ` · ${req.label}` : ''}`, prompt: p, answer: a });
  }
  return out;
}

export async function handleAsk(ctx: ToolContext, a: AskArgs, extra: ToolExtra, callerMeta: JobRequest['caller']): Promise<CallToolResult> {
  const { cfg, lay, target } = ctx;
  const g = cheapGuards(cfg);
  if (g) return refused(msg('guard_refused', { reason: g }));
  const notes: string[] = [];
  const startMs = Date.now();
  const waitS = clampWait(cfg, a.wait_seconds, notes);
  const effort = a.effort ?? (target === 'codex' ? cfg.codexDefaultEffort : cfg.claudeDefaultEffort);
  if (effort && !selectionValue(effort)) return refused(msg('effort_invalid', { effort }));
  const model = a.model ?? (target === 'codex' ? cfg.codexModel : cfg.claudeModel);
  if (model && !selectionValue(model)) return refused(msg('model_invalid'));
  if (effort) {
    try {
      const catalogue = await listModels(cfg, target);
      const item = catalogue.models.find((entry) => entry.id === model || entry.resolvedModel === model) ?? (!model ? catalogue.models.find((entry) => entry.isDefault) : undefined);
      if (item?.efforts && !item.efforts.includes(effort)) return refused(msg('effort_unsupported', { model: item.id, effort, list: item.efforts.join(', ') || 'yok' }));
      if (target === 'claude' && !item?.efforts) return refused(msg('claude_effort_unverified'));
    } catch (error) {
      if (target === 'claude') return refused((error as Error).message);
      notes.push(msg('catalogue_unavailable_note'));
    }
  }
  const access = a.access ?? 'read';
  if (access === 'write' && cfg.maxAccess !== 'write') return refused(msg('access_ceiling'));
  const network = a.network ?? false;
  const gitWrite = a.git_write ?? false;
  if (network && access !== 'write') return refused(msg('network_needs_write'));
  if (gitWrite && access !== 'write') return refused(msg('git_needs_write'));
  if (gitWrite && !cfg.allowGitWrite) return refused(msg('git_ceiling'));
  if (network && target === 'codex' && cfg.codexNetwork === 'deny') return refused(msg('network_ceiling_codex'));
  if (network && target === 'claude' && cfg.claudeNetwork === 'deny') return refused(msg('network_ceiling_claude'));
  const bytes = Buffer.byteLength(a.prompt, 'utf8') + Buffer.byteLength(a.context ?? '', 'utf8');
  if (bytes > cfg.maxPromptBytes) return refused(msg('too_big', { kb: Math.round(bytes / 1024), max: Math.round(cfg.maxPromptBytes / 1024) }));
  const running = runningJobs(cfg, lay);
  const runningT = running.filter((d) => isJobOf(path.basename(d), target));
  if (runningT.length >= cfg.maxRunningPerTarget || running.length >= cfg.maxRunningTotal) {
    // Re-check with liveness (finished-but-unmarked jobs are reaped here).
    const live = running.filter((d) => computeStatus(cfg, lay, d, { reap: true })?.status === 'running');
    const liveT = live.filter((d) => isJobOf(path.basename(d), target));
    if (liveT.length >= cfg.maxRunningPerTarget || live.length >= cfg.maxRunningTotal) return refused(msg('too_many_jobs', { n: live.length }));
  }

  // Session / workdir resolution.
  let sid: string | null = null;
  let session = null;
  if (a.session_id) {
    sid = normalizeUuid(a.session_id);
    session = sid ? readSession(lay.sessions, target, sid) : null;
    if (!sid || !session) return refused(msg('session_unknown'));
  }
  let workdir: string | null = null;
  let gitTop: string | null = null;
  let gitDirs: string[] = [];
  const wdInput = a.workdir ?? session?.workdir ?? undefined;
  if (wdInput) {
    try {
      const info = validateWorkdir(cfg, wdInput, access, packageRoot());
      workdir = info.real;
      gitTop = info.gitTop;
      gitDirs = [info.gitDir, info.gitCommonDir].filter((x): x is string => !!x);
    } catch (e) {
      if (e instanceof WorkdirError) return refused(e.message);
      throw e;
    }
  }
  if (session) {
    if (a.workdir && (session.workdir === null || caseFold(session.workdir) !== caseFold(workdir!))) {
      return refused(msg('session_workdir_mismatch', { workdir: session.workdir ?? 'yok' }));
    }
    if (access === 'write' && !session.workdir) return refused(msg('session_write_needs_workdir'));
  }
  if (access === 'write' && !workdir) return refused(msg('write_needs_workdir'));
  const review = a.review ? { scope: a.review.scope, ref: a.review.ref ?? null } : null;
  if (review) {
    const reason = reviewRefusal(review, { access, workdir, gitTop, session: !!session, shell: a.shell });
    if (reason) return refused(msg('review_refused', { reason }));
    const r = resolveReviewRef(cfg, workdir!, review);
    if ('reason' in r) return refused(msg('review_refused', { reason: r.reason }));
    review.ref = r.ref;
  }
  let shell: boolean;
  if (!workdir) {
    if (a.shell === true) return refused(msg('shell_needs_workdir'));
    shell = false;
  } else if (access === 'write') {
    if (a.shell === false) return refused(msg('shell_needed_write'));
    shell = true;
  } else {
    shell = a.shell ?? true;
    if (target === 'codex' && !shell) return refused(msg('shell_needed_codex'));
  }
  const web: Web = a.web ?? (target === 'codex' ? 'search' : workdir ? 'search' : 'live');
  if (target === 'claude' && workdir) {
    const verified = readClaudeRecord(cfg);
    if (verified && !verified[access]) return refused(msg('claude_sandbox_failed_ask', { access, detail: verified.details[access] ?? 'doğrulanamadı' }));
  }
  if (target === 'codex' && workdir) {
    const verified = readSandboxRecord(cfg, lay.caps);
    if (verified) {
      const d = decideCodexSandbox(cfg, { access, workdir, git_write: gitWrite, network, review }, verified);
      if ('error' in d) return refused(d.error);
    }
  }
  // A resumed conversation always runs in the cwd it started in (Claude stores sessions per cwd).
  const cwd = session?.cwd ?? workdir ?? fs.realpathSync.native(ensureScratch(lay));

  // Outgoing secret policy.
  let prompt = review ? reviewInstruction(review, a.prompt) : a.prompt;
  let context = a.context ?? null;
  const warnings: string[] = [];
  if (cfg.secretPolicy !== 'off') {
    const rp = redact(prompt, 'all');
    const rc = context ? redact(context, 'all') : { text: context, counts: {}, total: 0 };
    const kinds = [...new Set([...Object.keys(rp.counts), ...Object.keys(rc.counts)])];
    if (kinds.length) {
      if (cfg.secretPolicy === 'block') return refused(msg('secret_blocked', { kinds: kinds.join(', ') }));
      if (cfg.secretPolicy === 'redact') {
        prompt = rp.text;
        context = rc.text;
        notes.push(msg('secrets_redacted', { count: rp.total + rc.total, kinds: kinds.join(', ') }));
      } else {
        warnings.push(msg('secrets_warned', { kinds: kinds.join(', ') }));
      }
    }
  }
  if (workdir && access === 'read') {
    const writers = writeJobsOn(lay.locks, workdir, jobActivity(ctx));
    if (writers.length) warnings.push(msg('write_job_running', { jobs: writers.join(', ') }));
    // Before any project note is read: an unrestored workdir is not the project the user had.
    try {
      settleRestores(lay.locks, workdir, jobActivity(ctx), retryOf(ctx));
    } catch (e) {
      if (e instanceof RestorePending) return refused(restorePendingMessage(ctx, e.jobId));
      throw e;
    }
  }

  const jobId = newJobId(target);
  const n = nonce(3);
  const notesRes = !session ? collectProjectNotes(cfg, target, workdir, gitTop) : { notes: [], warnings: [] };
  warnings.push(...notesRes.warnings);
  const promptMd = composePrompt({ target, jobId, nonce: n, prompt, context, access, shell, web, network, gitWrite, workdir, notes: notesRes.notes, resume: !!session });
  const fallbackMd = session
    ? composePrompt({ target, jobId, nonce: n, prompt, context, access, shell, web, network, gitWrite, workdir, notes: collectProjectNotes(cfg, target, workdir, gitTop).notes, resume: false, previousTurns: previousTurns(ctx, session.jobs) })
    : null;
  const now = Date.now();
  const req: JobRequest = {
    schema: 1, job_id: jobId, target, created_at: new Date(now).toISOString(), created_at_ms: now, nonce: n, access, workdir, cwd,
    git_top: gitTop, git_dirs: gitDirs, shell, web, network, git_write: gitWrite, review, effort, model, label: sanitizeLabel(a.label),
    session_id_requested: sid, new_session_id: target === 'claude' && !sid ? newUuid() : null,
    prompt_chars: prompt.length, context_chars: context?.length ?? 0, prompt_preview: redact(prompt.slice(0, 200), 'all').text,
    caller: callerMeta, host: cfg.host, warnings,
  };
  const dir = path.join(jobsDirectory(ctx), jobId);
  fs.mkdirSync(dir, { mode: 0o700 });
  const meta: Meta = { schema: 1, job_id: jobId, target, status: 'starting', phase: 'starting', created_at: req.created_at, notes: [...notes], warnings: [...warnings], attempts: [], versions: { server: VERSION } };
  writeRequest(dir, req);
  writeAtomic(path.join(dir, JobFiles.prompt), promptMd);
  if (fallbackMd) writeAtomic(path.join(dir, JobFiles.promptFallback), fallbackMd);
  writeMeta(dir, meta);
  try {
    acquireLocks(lay.locks, jobId, { workdir: access === 'write' ? workdir! : undefined, session: sid ? { target, id: sid } : undefined }, jobActivity(ctx), retryOf(ctx));
  } catch (e) {
    // The job never started: drop its own marker too, or the removed job would block the workdir.
    clearRestorePending(lay.locks, jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    if (e instanceof LockConflict) return refused(msg(e.kind === 'workdir' ? 'workdir_locked' : 'session_busy', { job_id: e.jobId }));
    if (e instanceof RestorePending) return refused(restorePendingMessage(ctx, e.jobId));
    throw e;
  }
  try {
    spawnRunner(cfg, dir);
  } catch (e) {
    writeFinalOnce(dir, { status: 'error', error_kind: 'runner_start_failed', error_message: msg('node_missing') + ` (${(e as Error).message})`, by: 'runner', finished_at: new Date().toISOString(), child_code: null, has_answer: false, partial_answer: false }, 1);
    clearRestorePending(lay.locks, jobId); // no runner, so the workdir was never touched
    releaseLocks(lay.locks, jobId);
  }
  const v = waitS > 0 ? await waitForJob(cfg, lay, dir, waitS, startMs, extra.signal, progressReporter(extra)) : computeStatus(cfg, lay, dir, { reap: false });
  if (!v) return refused(msg('internal', { detail: 'iş okunamadı' }));
  return textResult(renderJob(v, renderOptions(ctx, notes.filter((x) => !meta.notes.includes(x)))));
}

function retryOf(ctx: ToolContext): (jobId: string) => boolean {
  return (jobId) => retryRestore(ctx.cfg, ctx.lay, jobId);
}

function restorePendingMessage(ctx: ToolContext, jobId: string): string {
  const dir = resolveJobDir(jobsDirectory(ctx), jobId);
  return dir
    ? msg('restore_pending', { job_id: jobId, archive: path.join(dir, JobFiles.protect) })
    : msg('restore_pending_no_archive', { job_id: jobId, marker: restorePendingFile(ctx.lay.locks, jobId) });
}

function ensureScratch(lay: Layout): string {
  ensureDir0700(lay.scratch);
  return lay.scratch;
}
