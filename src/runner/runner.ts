import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Config, Layout } from '../config/config.js';
import { appendFileSafe, ensureDir0700, exists, readTextSafe, readTail, writeAtomic, writeJsonAtomic, privateTemporaryDirectory } from '../system/fs.js';
import { JobFiles, attemptAnswerFile, attemptSettingsFile, isFinished, updateMeta } from '../jobs/store.js';
import { buildChildEnv, resolveLaunch } from '../providers/child-env.js';
import { codexCaps, claudeVersion, cmpVersion, MIN_CLAUDE, MIN_CODEX, readSandboxRecord, type CodexCaps } from '../providers/capabilities.js';
import { isolateMcp } from '../providers/codex/mcp-isolation.js';
import { decideCodexSandbox } from '../providers/codex/sandbox-plan.js';
import { buildCodexArgv, codexBaseUrlArgs, redactCodexArgv, type CodexSandbox } from '../providers/codex/argv.js';
import { buildClaudeArgv, buildClaudeSettings, mergeUserDeny, redactClaudeArgv, writeClaudeSettings, type ClaudeArgvInput } from '../providers/claude/argv.js';
import { feedCodex, newCodexState, sessionIdFromStderr, type CodexState } from '../providers/codex/events.js';
import { codexDefaults } from '../providers/codex/defaults.js';
import { feedClaude, newClaudeState, type ClaudeState } from '../providers/claude/events.js';
import { classify, planNext, type Outcome, type PlannedAttempt } from '../jobs/outcome.js';
import type { ErrorKind, JobRequest, JobResult, Meta } from '../domain/job.js';
import { snapshot, finalizeProtect, topLevelState, cleanupPlaceholders } from '../security/protected-files.js';
import { gitLayout, gitReadOnly, gitWatchRels, type GitLayout } from '../security/git-layout.js';
import { changesBefore, changesAfter, type ChangesBefore } from '../jobs/changes.js';
import { descendants, signalAll, isGone } from '../system/platform/index.js';
import { clearRestorePending, releaseLocks } from '../jobs/locks.js';
import { upsertSession } from '../jobs/sessions.js';
import { msg } from '../shared/messages.js';
import { newUuid } from '../domain/ids.js';
import { redact } from '../shared/redact.js';
import { ensureCodexVerified, ensureClaudeVerified } from '../providers/verification.js';
import { jobErrorMessage } from './error-messages.js';

type Flag = 'cancelled' | 'timeout' | 'self_check';

export class Runner {
  private flag: Flag | null = null;
  private flagDetail = '';
  private child: ChildProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  private caffeinate: ChildProcess | null = null;
  private readonly tmpDir: string;
  private log = (s: string): void => appendFileSafe(path.join(this.dir, JobFiles.runnerLog), `[${new Date().toISOString()}] ${redact(s, 'all').text}\n`);

  constructor(private cfg: Config, private lay: Layout, private dir: string, private req: JobRequest) {
    this.tmpDir = privateTemporaryDirectory();
  }

  /**
   * A meta update that only informs (phase, progress, final details). It runs from timers and stream
   * handlers, so a failed write (Windows keeps meta.json briefly locked) is logged, never thrown:
   * the job's outcome is committed by result.json and exit_code, not by meta.
   */
  private noteMeta(fn: (m: Meta) => void): void {
    try {
      updateMeta(this.dir, fn);
    } catch (e) {
      this.log(`meta update failed: ${String(e)}`);
    }
  }

  /** Stop the running CLI's process tree (graceful, then forced) and wait for it to exit. */
  private async stopChild(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid || isGone(pid)) return;
    signalAll([pid, ...descendants([pid])], 'SIGTERM');
    for (let waited = 0; waited < 3000 && !isGone(pid); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isGone(pid)) signalAll([pid, ...descendants([pid])], 'SIGKILL');
  }

  requestCancel(kind: Flag, detail = ''): void {
    if (this.flag) return;
    this.flag = kind;
    this.flagDetail = detail;
    this.log(`cancel requested: ${kind} ${detail}`);
    try {
      writeAtomic(path.join(this.dir, JobFiles.cancelAck), `${kind}\n`);
    } catch {
      /* ignore */
    }
    this.noteMeta((m) => (m.phase = 'cancelling'));
    const c = this.child;
    if (!c?.pid) return;
    const pid = c.pid;
    // SIGINT first: Claude records the turn on SIGINT; codex interrupts the turn.
    try {
      signalAll([pid], 'SIGINT');
    } catch {
      /* gone */
    }
    const t1 = setTimeout(() => {
      if (isGone(pid)) return;
      signalAll([pid, ...descendants([pid])], 'SIGTERM');
      const t2 = setTimeout(() => {
        if (!isGone(pid)) signalAll([pid, ...descendants([pid])], 'SIGKILL');
      }, 4000);
      this.timers.push(t2);
    }, this.cfg.cancelGraceMs);
    this.timers.push(t1);
  }

  private installWatchers(): void {
    process.on('SIGTERM', () => this.requestCancel('cancelled', 'SIGTERM'));
    process.on('SIGINT', () => this.requestCancel('cancelled', 'SIGINT'));
    process.on('SIGHUP', () => undefined);
    const poll = setInterval(() => {
      if (exists(path.join(this.dir, JobFiles.cancelRequested))) this.requestCancel('cancelled');
    }, 1000);
    poll.unref();
    this.timers.push(poll);
    const to = setTimeout(() => this.requestCancel('timeout', `${this.cfg.maxJobMinutes} dk`), this.cfg.maxJobMinutes * 60_000);
    to.unref();
    this.timers.push(to);
  }

  private startCaffeinate(): void {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/caffeinate')) return;
    try {
      this.caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.caffeinate.unref();
    } catch {
      this.caffeinate = null;
    }
  }

  async run(): Promise<void> {
    this.installWatchers();
    updateMeta(this.dir, (m) => {
      m.status = 'running';
      m.phase = 'preparing';
      m.started_at = new Date().toISOString();
    });
    let outcome: Outcome = { ok: false, kind: 'internal', detail: '' };
    let lastAttempt: PlannedAttempt | null = null;
    let usedEffort = this.req.effort;
    let sessionId: string | null = null;
    let finalMode: 'new' | 'resume' = this.req.session_id_requested ? 'resume' : 'new';
    let protectBefore = false;
    let chBefore: ChangesBefore | null = null;
    // null until captured below: a job that fails before then has run nothing sandboxed, so it left no placeholders.
    let topLevel: string[] | null = null;
    const eventsPaths: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];
    let usage: Record<string, number | undefined> | undefined;
    const denials: string[] = [];
    let childCode: number | null = null;
    try {
      ensureDir0700(this.tmpDir);
      if (exists(path.join(this.dir, JobFiles.cancelRequested))) this.requestCancel('cancelled');
      const target = this.req.target;
      const bin = target === 'codex' ? this.cfg.bins.codex : this.cfg.bins.claude;
      if (!bin || !fs.existsSync(bin)) {
        throw new KindError('bin_missing', msg('bin_missing', { cli: target === 'codex' ? 'codex' : 'claude', var: target === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN' }));
      }
      const { env, dropped } = buildChildEnv(this.cfg, process.env, { target, jobId: this.req.job_id, tmpDir: this.tmpDir, cliBin: bin });
      this.log(`child env built; dropped vars: ${dropped.join(',')}`);
      // Every repository in a write workdir is protected (hooks, config, redirects); unseen ones cannot be.
      let git: GitLayout | null = null;
      if (this.req.access === 'write' && this.req.workdir) {
        git = gitLayout(this.req.cwd);
        if (!git.complete) throw new KindError('workdir_scan_incomplete', msg('workdir_scan_incomplete'));
        this.log(`git layout: ${git.entries.length} .git entries, ${git.gitDirs.length} git dirs`);
      }
      const gitOpts = git ? { readOnly: gitReadOnly(this.req.cwd, git, this.req.git_write), topWritable: git.topIsDir } : undefined;
      let caps: CodexCaps | null = null;
      let sandbox: CodexSandbox = { kind: 'legacy' };
      let mcpOverride = '';
      let sandboxLabel = '';
      if (target === 'codex') {
        const c = codexCaps(this.cfg, this.lay.caps, env);
        if ('error' in c) throw new KindError('bin_missing', c.error);
        if (cmpVersion(c.version, MIN_CODEX) < 0) throw new KindError('cli_too_old', msg('cli_too_old', { cli: 'codex', version: c.version, min: MIN_CODEX }));
        caps = c;
        if (this.req.workdir) await ensureCodexVerified(this.cfg);
        if (this.flag) throw new KindError(this.flag, this.flagDetail);
        const d = decideCodexSandbox(this.cfg, this.req, readSandboxRecord(this.cfg, this.lay.caps), gitOpts);
        if ('error' in d) throw new KindError(d.kind, d.error);
        sandbox = d.sandbox;
        sandboxLabel = d.label;
        warnings.push(...d.warnings);
        const iso = isolateMcp(this.cfg, this.lay.caps, env, this.req.cwd, caps);
        if ('error' in iso) throw new KindError('mcp_isolation_failed', msg('mcp_isolation_failed', { detail: iso.error }));
        mcpOverride = iso.override;
        this.log(`mcp isolation: ${iso.names.length} user servers disabled`);
      } else {
        const v = claudeVersion(this.cfg, env);
        if (typeof v !== 'string') throw new KindError('bin_missing', v.error);
        if (cmpVersion(v, MIN_CLAUDE) < 0) throw new KindError('cli_too_old', msg('cli_too_old', { cli: 'claude', version: v, min: MIN_CLAUDE }));
        if (this.req.workdir) {
          const verified = await ensureClaudeVerified(this.cfg);
          if (!verified?.[this.req.access]) throw new KindError('sandbox_unavailable', msg('claude_sandbox_failed', { access: this.req.access, detail: verified?.details[this.req.access] ?? 'doğrulanamadı' }));
        }
        if (this.flag) throw new KindError(this.flag, this.flagDetail);
        sandboxLabel = this.req.access === 'write' ? 'claude-sandbox(yazma)' : this.req.shell ? 'claude(okuma+salt-okuma kabuk)' : 'claude(okuma)';
      }
      updateMeta(this.dir, (m) => {
        m.sandbox = sandboxLabel;
        m.warnings.push(...warnings);
      });
      if (this.req.workdir) topLevel = topLevelState(this.req.cwd);
      if (git) {
        snapshot(this.req.cwd, this.dir, { watch: gitWatchRels(git), entries: git.entries, complete: git.complete });
        protectBefore = true;
        chBefore = changesBefore(this.cfg, this.req.cwd);
      }
      this.startCaffeinate();
      const userDeny = target === 'claude' ? mergeUserDeny(this.cfg, this.req.cwd) : { rules: [], warnings: [] };
      if (userDeny.warnings.length) updateMeta(this.dir, (m) => m.warnings.push(...userDeny.warnings));

      let attempt: PlannedAttempt | null = {
        n: 1,
        effort: this.req.effort,
        mode: this.req.session_id_requested ? 'resume' : 'new',
        stdin: JobFiles.prompt,
      };
      const tried: PlannedAttempt[] = [];
      let claudeSid = this.req.session_id_requested ?? this.req.new_session_id ?? newUuid();
      while (attempt && !this.flag) {
        tried.push(attempt);
        lastAttempt = attempt;
        if (attempt.n > 1) updateMeta(this.dir, (m) => (m.phase = 'retrying'));
        if (target === 'claude' && attempt.mode === 'new' && attempt.n > 1) claudeSid = newUuid();
        const res = await this.runAttempt(attempt, { bin, env, caps, sandbox, mcpOverride, userDeny: userDeny.rules, claudeSid, gitReadOnly: gitOpts?.readOnly });
        outcome = res.outcome;
        childCode = res.exitCode;
        if (res.codex) {
          eventsPaths.push(...res.codex.fileChanges.map((f) => f.path));
          if (res.codex.usage) usage = res.codex.usage;
          sessionId = res.codex.threadId ?? sessionIdFromStderr(readTail(path.join(this.dir, JobFiles.stderr), 200_000)) ?? sessionId;
          // Codex does not report its model; without an explicit one it is the configured default.
          const defaults = codexDefaults(this.cfg.codexHome);
          const model = this.req.model || defaults.model;
          const effort = attempt.effort || defaults.effort;
          this.noteMeta((m) => {
            if (model) m.resolved_model = model;
            if (effort) m.effective_effort = effort;
          });
        }
        if (res.claude) {
          if (res.claude.init?.model) this.noteMeta((m) => { m.resolved_model = res.claude!.init!.model; });
          const usedEffort = attempt.effort;
          if (usedEffort) this.noteMeta((m) => { m.effective_effort = usedEffort; });
          const r = res.claude.result;
          if (r?.usage) usage = { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, total_cost_usd: r.total_cost_usd };
          for (const d of r?.permission_denials ?? []) denials.push(`${d.tool_name}(${JSON.stringify(d.tool_input ?? {}).slice(0, 80)})`);
          sessionId = r?.session_id ?? claudeSid;
        }
        const next = planNext(attempt, outcome, tried);
        if (next && !outcome.ok && outcome.kind === 'resume_not_found') notes.push(msg('resume_fallback_note'));
        if (outcome.ok) {
          usedEffort = attempt.effort;
          finalMode = attempt.mode;
        }
        attempt = next;
      }
      if (this.flag && (outcome.ok || !lastAttempt)) {
        outcome = { ok: false, kind: this.flag, detail: this.flagDetail, partial: outcome.ok ? outcome.answer : undefined };
      }
    } catch (e) {
      if (e instanceof KindError) outcome = { ok: false, kind: e.kind, detail: e.message };
      else outcome = { ok: false, kind: 'internal', detail: (e as Error)?.stack ?? String(e) };
      this.log(`error: ${(e as Error)?.stack ?? String(e)}`);
      // An error while the CLI runs must not leave it working after the job is committed and unlocked.
      await this.stopChild();
    }
    await this.finalize({ outcome, usedEffort, sessionId, finalMode, protectBefore, chBefore, topLevel, eventsPaths, notes, usage, denials, childCode, lastAttempt });
  }

  private async runAttempt(
    a: PlannedAttempt,
    ctx: { bin: string; env: Record<string, string>; caps: CodexCaps | null; sandbox: CodexSandbox; mcpOverride: string; userDeny: string[]; claudeSid: string; gitReadOnly?: string[] },
  ): Promise<{ outcome: Outcome; exitCode: number | null; codex?: CodexState; claude?: ClaudeState }> {
    const r = this.req;
    const target = r.target;
    const answerFile = path.join(this.dir, attemptAnswerFile(a.n));
    let argv: string[];
    let redacted: string[];
    let marker: string;
    let settingsFile: string | null = null;
    let settings: Record<string, unknown> | null = null;
    if (target === 'codex') {
      const extra = codexBaseUrlArgs(this.cfg);
      argv = buildCodexArgv({
        mode: a.mode, sessionId: r.session_id_requested ?? undefined, access: r.access, shell: r.shell, web: r.web, cwd: r.cwd,
        answerFile, model: r.model, effort: a.effort, jobId: r.job_id, sandbox: ctx.sandbox, mcpOverride: ctx.mcpOverride,
        features: ctx.caps, allowSlashTmp: this.cfg.allowSlashTmp, netOpen: r.network && this.cfg.codexNetwork === 'open', review: !!r.review, extra,
      });
      redacted = redactCodexArgv(argv);
      marker = r.job_id; // in the argv via shell_environment_policy.set.CLIVOXA_JOB_ID (ASCII, unique)
    } else {
      settingsFile = path.join(this.dir, attemptSettingsFile(a.n));
      const input: ClaudeArgvInput = {
        mode: a.mode, sessionId: a.mode === 'resume' ? r.session_id_requested! : ctx.claudeSid, access: r.access, shell: r.shell, web: r.web,
        network: r.network, gitWrite: r.git_write, cwd: r.cwd, tmpDir: this.tmpDir, model: r.model, effort: a.effort, files: !!r.workdir,
        jobId: r.job_id, agent: this.cfg.claudeAgent, gitDirs: r.git_dirs, gitReadOnly: ctx.gitReadOnly, userDeny: ctx.userDeny, settingsFile,
      };
      // A file, not inline JSON: deny lists can pass Windows' 32K command-line limit. Written just before spawn.
      settings = buildClaudeSettings(this.cfg, input);
      argv = buildClaudeArgv(input);
      redacted = redactClaudeArgv(argv);
      marker = `clivoxa-${r.job_id}`;
      updateMeta(this.dir, (m) => (m.session_id = a.mode === 'resume' ? r.session_id_requested : ctx.claudeSid));
    }
    const stdinFile = path.join(this.dir, a.stdin);
    const header = { type: 'clivoxa.attempt', n: a.n, effort: a.effort, mode: a.mode, stdin: a.stdin, at: new Date().toISOString() };
    appendFileSafe(path.join(this.dir, JobFiles.events), JSON.stringify(header) + '\n');
    appendFileSafe(path.join(this.dir, JobFiles.stderr), `=== clivoxa deneme ${a.n} (${a.mode}, effort ${a.effort}) ${header.at} ===\n`);
    const launch = resolveLaunch(this.cfg, ctx.bin);
    const errFd = fs.openSync(path.join(this.dir, JobFiles.stderr), 'a', 0o600);
    const inFd = fs.openSync(stdinFile, 'r');
    const started = new Date().toISOString();
    updateMeta(this.dir, (m) => {
      m.phase = a.n > 1 ? 'retrying' : 'running';
      m.attempts.push({ n: a.n, effort: a.effort, mode: a.mode, stdin: a.stdin, started_at: started });
    });
    const codex = target === 'codex' ? newCodexState() : undefined;
    const claude = target === 'claude' ? newClaudeState() : undefined;
    const expected = {
      access: r.access, shell: r.access === 'write' ? true : r.shell, agent: this.cfg.claudeAgent,
      permissionMode: r.access === 'write' ? 'acceptEdits' : 'dontAsk', cwd: r.cwd, allowApiKey: this.cfg.allowApiKeyAuth,
    };
    const dropSettings = (): void => {
      try { if (settingsFile) fs.rmSync(settingsFile, { force: true }); } catch { /* private job file; the archive keeps it */ }
    };
    // Nothing runs between this write and spawn, so the file cannot outlive a failed attempt.
    try {
      if (settingsFile && settings) writeClaudeSettings(settingsFile, settings);
    } catch (e) {
      fs.closeSync(errFd);
      fs.closeSync(inFd);
      dropSettings();
      throw e;
    }
    let child: ChildProcess;
    try {
      child = spawn(launch.cmd, [...launch.pre, ...argv], { cwd: r.cwd, env: ctx.env, windowsHide: true, stdio: [inFd, 'pipe', errFd] });
    } catch (e) {
      fs.closeSync(errFd);
      fs.closeSync(inFd);
      dropSettings();
      return { outcome: { ok: false, kind: 'spawn_failed', detail: String((e as Error).message) }, exitCode: null, codex, claude };
    }
    fs.closeSync(errFd);
    fs.closeSync(inFd);
    this.child = child;
    let spawnError: string | undefined;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    if (child.pid) {
      this.noteMeta((m) => (m.child = { pid: child.pid!, marker, argv_redacted: redacted }));
    }
    if (this.flag) {
      try {
        signalAll([child.pid!], 'SIGINT');
      } catch {
        /* ignore */
      }
    }
    let lastProgress = 0;
    const evFile = path.join(this.dir, JobFiles.events);
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      appendFileSafe(evFile, line + '\n');
      const v = codex ? feedCodex(codex, line, { access: r.access, shell: r.shell }) : feedClaude(claude!, line, expected);
      if (v) this.requestCancel('self_check', v);
      const now = Date.now();
      if (now - lastProgress > 5000) {
        lastProgress = now;
        const st = codex ?? claude!;
        this.noteMeta((m) => (m.progress = { at: new Date().toISOString(), summary: st.lastActivity ?? 'çalışıyor', events: st.events }));
      }
    });
    const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.on('close', (c, s) => resolve([c, s]));
    });
    rl.close();
    this.child = null;
    dropSettings();
    try {
      fs.chmodSync(answerFile, 0o600); // codex creates it with the default umask
    } catch {
      /* not written */
    }
    const answerText = target === 'codex' ? readTextSafe(answerFile) : null;
    const outcome = classify({
      target, mode: a.mode, effort: a.effort, exitCode: code, signal: sig, runnerFlag: this.flag, runnerFlagDetail: this.flagDetail,
      answerFileText: answerText, codex, claude, stderrTail: readTail(path.join(this.dir, JobFiles.stderr), 16 * 1024), spawnError,
    });
    this.noteMeta((m) => {
      const rec = m.attempts.find((x) => x.n === a.n);
      if (rec) {
        rec.ended_at = new Date().toISOString();
        rec.exit_code = code;
        rec.signal = sig;
        rec.session_id = codex?.threadId ?? claude?.result?.session_id ?? null;
        rec.outcome = outcome.ok ? 'ok' : outcome.kind;
        if (!outcome.ok) {
          rec.error_kind = outcome.kind;
          rec.error_detail = redact(outcome.detail, 'all').text.slice(0, 2000);
        }
      }
    });
    this.log(`attempt ${a.n} exit=${code} sig=${sig} outcome=${outcome.ok ? 'ok' : outcome.kind}`);
    return { outcome, exitCode: code, codex, claude };
  }

  private async finalize(s: {
    outcome: Outcome; usedEffort: string; sessionId: string | null; finalMode: 'new' | 'resume'; protectBefore: boolean;
    chBefore: ChangesBefore | null; topLevel: string[] | null; eventsPaths: string[]; notes: string[];
    usage: Record<string, number | undefined> | undefined; denials: string[]; childCode: number | null; lastAttempt: PlannedAttempt | null;
  }): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.noteMeta((m) => (m.phase = 'finishing'));
    const r = this.req;
    let protectedSummary = null;
    let protectFailed = false;
    let changes = null;
    if (s.protectBefore) {
      try {
        protectedSummary = finalizeProtect(this.dir, this.cfg.protectedPolicy);
      } catch (e) {
        protectFailed = true;
        this.log(`protect finalize failed: ${String(e)}`);
      }
      try {
        if (s.chBefore) {
          changes = changesAfter(this.cfg, r.cwd, s.chBefore, s.eventsPaths);
          writeJsonAtomic(path.join(this.dir, JobFiles.changes), changes);
        }
      } catch (e) {
        this.log(`changes failed: ${String(e)}`);
      }
    }
    // Restored, or never snapshotted (the child never ran): jobs on this workdir need not wait for it.
    if (r.access === 'write' && !protectFailed) clearRestorePending(this.lay.locks, r.job_id);
    if (r.workdir && s.topLevel) {
      try {
        cleanupPlaceholders(r.cwd, s.topLevel);
      } catch {
        /* ignore */
      }
    }
    const o = s.outcome;
    if (o.ok) writeAtomic(path.join(this.dir, JobFiles.answer), o.answer + '\n');
    else if (o.partial?.trim()) writeAtomic(path.join(this.dir, JobFiles.partial), o.partial.trim() + '\n');
    if (o.ok && s.sessionId) {
      try {
        upsertSession(this.lay.sessions, {
          session_id: s.sessionId, target: r.target, cwd: r.cwd, workdir: r.workdir, last_access: r.access, model: r.model, effort: s.usedEffort, job_id: r.job_id,
        });
      } catch (e) {
        this.log(`session index failed: ${String(e)}`);
      }
    }
    const resumed = o.ok && s.finalMode === 'resume';
    this.noteMeta((m) => {
      m.status = o.ok ? 'done' : 'error';
      m.phase = 'finished';
      m.finished_at = new Date().toISOString();
      if (s.sessionId) m.session_id = s.sessionId;
      m.resumed = resumed;
      m.effort_used = s.usedEffort;
      m.notes.push(...s.notes);
      if (s.usage) m.usage = s.usage;
      if (s.denials.length) m.permission_denials = [...new Set(s.denials)].slice(0, 50);
      if (protectedSummary) m.protected = { ...protectedSummary, items: protectedSummary.items.filter((i) => i.action !== 'placeholder_removed') };
      if (changes) m.changes = changes;
      if (protectFailed) m.warnings.push(msg('protect_restore_failed'));
    });
    const result: JobResult = {
      status: o.ok ? 'done' : 'error',
      ...(o.ok ? {} : { error_kind: o.kind, error_message: jobErrorMessage(r.target, o.kind, o.detail, this.cfg), error_detail: redact(o.detail, 'all').text.slice(0, 4000) }),
      by: 'runner',
      finished_at: new Date().toISOString(),
      child_code: s.childCode,
      has_answer: o.ok,
      partial_answer: !o.ok && !!o.partial?.trim(),
    };
    if (isFinished(this.dir)) result.reaped_in_error = true;
    const code = o.ok ? 0 : o.kind === 'cancelled' || o.kind === 'timeout' ? 130 : s.childCode && s.childCode > 0 ? s.childCode : 1;
    writeJsonAtomic(path.join(this.dir, JobFiles.result), result);
    writeAtomic(path.join(this.dir, JobFiles.exitCode), `${code}\n`);
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    releaseLocks(this.lay.locks, r.job_id);
    try {
      this.caffeinate?.kill();
    } catch {
      /* ignore */
    }
  }
}

class KindError extends Error {
  constructor(public kind: ErrorKind, message: string) {
    super(message);
  }
}
