import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { systemEnvironment } from '../../dist/system/platform/index.js';
import { discoverExecutable } from '../../dist/system/executables.js';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DIST = path.join(ROOT, 'dist', 'index.js');
export const FAKE_CODEX = path.join(ROOT, 'test', 'fakes', 'codex.mjs');
export const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakes', 'claude.mjs');

/** A fresh fake HOME with a project directory (and a git repo when asked). */
export function mkHome({ git = false } = {}) {
  // Windows TEMP is under AppData, which is deliberately forbidden as a workdir.
  // Keep project fixtures outside both AppData and the bridge installation itself.
  const temporaryRoot = process.platform === 'win32' ? path.join(path.dirname(ROOT), '.clivoxa-test-tmp') : os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryRoot, 'tt-home-')));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# proje\n');
  if (git) {
    const git = discoverExecutable('git', process.env, home);
    const g = (args) => spawnSync(git ?? 'git', args, { cwd: proj, env: { ...systemEnvironment(), PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
    g(['init', '-q']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'add', '-A']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  }
  return { home, proj, clivoxa: path.join(home, '.clivoxa'), argvLog: path.join(home, 'argv.log') };
}

export function baseEnv(h, role, extra = {}) {
  return {
    HOME: h.home,
    ...systemEnvironment(),
    PATH: [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)].join(path.delimiter),
    LANG: 'C.UTF-8',
    CLIVOXA_EXPOSE: role,
    CODEX_MODEL: 'gpt-6-astra',
    CLAUDE_MODEL: 'opus',
    CLIVOXA_CODEX_DEFAULT_EFFORT: 'high',
    CLIVOXA_CLAUDE_DEFAULT_EFFORT: 'high',
    CLIVOXA_HOST: role === 'codex' ? 'claude-code' : 'codex',
    CLIVOXA_HOME: h.clivoxa,
    CODEX_BIN: FAKE_CODEX,
    CLAUDE_BIN: FAKE_CLAUDE,
    NODE_BIN: process.execPath,
    GIT_BIN: discoverExecutable('git', process.env, h.home) ?? '',
    CODEX_HOME: path.join(h.home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(h.home, '.claudecfg'),
    CLIVOXA_POLL_MS: '50',
    CLIVOXA_CANCEL_GRACE_MS: '300',
    CLIVOXA_STARTUP_GRACE_MS: '4000',
    CLIVOXA_CHILD_ENV_PASS: 'FAKE_ARGV_LOG,FAKE_CODEX_FEATURES,FAKE_CODEX_SERVERS,FAKE_CODEX_STUCK,FAKE_CLIVOXA_DIST,FAKE_CLIVOXA_HOME,FAKE_LOOP_RESULT,FAKE_LOOP_CWD',
    FAKE_ARGV_LOG: h.argvLog,
    ...extra,
  };
}

export async function startServer(h, role, extra = {}) {
  // Fake CLIs do not enforce an OS sandbox. These fixture records exercise the
  // bridge's lifecycle/argv/backstop contracts; real sandbox tests use real CLIs.
  const env = baseEnv(h, role, extra);
  const { loadConfig } = await import('../../dist/config/config.js');
  const { binFingerprint, sandboxContext } = await import('../../dist/providers/capabilities.js');
  const cfg = loadConfig(env);
  fs.mkdirSync(path.join(cfg.home, 'caps'), {recursive:true,mode:0o700});
  if (env.CODEX_BIN === FAKE_CODEX && !extra.__unverified) {
    const fp=binFingerprint(FAKE_CODEX);
    const file=path.join(cfg.home,'caps',`codex-sandbox-${fp}.json`);
    if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({fp,context:sandboxContext(cfg),at:Date.now(),version:'0.162.1',profiles_verified:{ro:true,rw:true,rw_git:true,rw_net:true},details:{}}));
  }
  if (env.CLAUDE_BIN === FAKE_CLAUDE && !extra.__unverified) {
    const fp=binFingerprint(FAKE_CLAUDE);
    const file=path.join(cfg.home,'caps',`claude-sandbox-${fp}.json`);
    if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({fp,context:sandboxContext(cfg),at:Date.now(),settings:'file',read:true,write:true,details:{}}));
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST], env: baseEnv(h, role, extra), stderr: 'pipe', cwd: extra.__cwd ?? h.home });
  const stderr = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: 'clivoxa-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    stderr,
    async call(name, args = {}) {
      let r;
      try { r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }); }
      catch (error) { error.message += `\nServer stderr: ${stderr.join('').slice(-8000)}`; throw error; }
      const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
      return { text, isError: !!r.isError, raw: r, h: parseHeader(text), answer: parseAnswer(text) };
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

export function parseHeader(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('Aşağıdaki bölüm')) break;
    const m = /^([a-zA-Z_]+): ?(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

export function parseAnswer(text) {
  const m = /<<<YANIT_([0-9a-f]+)\n([\s\S]*)\nYANIT_SONU_\1>>>/.exec(text);
  return m ? m[2] : null;
}

export function argvLog(h) {
  try {
    return fs.readFileSync(h.argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function untilDone(srv, jobId, maxMs = 60_000) {
  const t0 = Date.now();
  let r;
  do {
    r = await srv.call('get_job', { job_id: jobId, wait_seconds: 5 });
    if (r.h.status !== 'running') return r;
  } while (Date.now() - t0 < maxMs);
  return r;
}

export function jobDir(h, jobId) {
  return path.join(h.clivoxa, 'jobs', jobId);
}

/** Kill every process a test home's jobs started, then delete the home (unless CLIVOXA_KEEP_TEST_HOMES=1). */
export function cleanupHome(h) {
  killJobProcs(h);
  if (process.env.CLIVOXA_KEEP_TEST_HOMES === '1') return;
  try {
    fs.rmSync(h.home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

export function killJobProcs(h) {
  const jobs = path.join(h.clivoxa, 'jobs');
  let names = [];
  try {
    names = fs.readdirSync(jobs);
  } catch {
    return;
  }
  for (const n of names) {
    for (const f of ['runner.json', 'meta.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(jobs, n, f), 'utf8'));
        const pid = f === 'runner.json' ? j.pid : j.child?.pid;
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}
