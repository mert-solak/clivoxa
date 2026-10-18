// Zero-cost verification of the Codex permission profiles (`doctor --verify`).
// Runs the REAL codex binary with the EXACT production argv (plus a loopback mock model), lets the
// mock model drive shell commands through gpt-6-astra's code-mode `exec` tool, then checks the
// effects on the host filesystem. Writes caps/codex-sandbox-<fp>.json that gates Codex write mode.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockResponses } from './mock-models.mjs';
import { sanitizedCodexConfig } from './codex-config-copy.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const imp = (m) => import(pathToFileURL(path.join(DIST, m)).href);

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Staging left by a verification that was killed before its cleanup (an hour is far past any run). */
export function sweepStaleVerifications(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^verify-[0-9a-f]{8}$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory() && now - st.mtimeMs > 3600_000) rmrf(p);
    } catch {
      /* ignore */
    }
  }
}

async function localServer() {
  const srv = http.createServer((q, s) => s.end('NETOK'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

function runCodex(cmd, args, env, cwd, stdin, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve({code:127,out,err:'CLI spawn failed'}); });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    p.stdin.end(stdin);
  });
}

/**
 * The exec_command line that runs `program` with `node` (PowerShell on Windows, a POSIX shell elsewhere).
 * The program travels in `dir/probe.cjs`, never `-e`: Windows PowerShell 5.1 drops the double quotes
 * of an argument it passes to a native program, which turned every probe into a SyntaxError.
 */
export function probeCommand(node, program, dir) {
  const quote = process.platform === 'win32'
    ? value => "'" + value.replace(/'/g, "''") + "'"
    : value => "'" + value.replace(/'/g, "'\\''") + "'";
  const probeFile = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probeFile, program, { mode: 0o600 });
  return (process.platform === 'win32' ? '& ' : '') + quote(node) + ' ' + quote(probeFile);
}

/**
 * @param {{cfg: any, log?: (s: string) => void, mutateToml?: (mode: string, toml: string) => string, modes?: string[], writeRecord?: boolean}} o
 * @returns {Promise<{record: any, details: Record<string,string>}>}
 */
export async function verifyCodexProfiles(o) {
  const log = o.log ?? (() => undefined);
  const { cfg } = o;
  const { layout } = await imp('config/config.js');
  const { buildChildEnv, resolveLaunch } = await imp('providers/child-env.js');
  const { codexCaps, binFingerprint, sandboxRecordPath, sandboxContext } = await imp('providers/capabilities.js');
  const { isolateMcp } = await imp('providers/codex/mcp-isolation.js');
  const { buildCodexArgv, profileToml, profileName } = await imp('providers/codex/argv.js');
  const { gitLayout, gitReadOnly } = await imp('security/git-layout.js');
  const { systemEnvironment } = await imp('system/platform/index.js');
  const { writeJsonAtomic } = await imp('system/fs.js');
  const lay = layout(cfg);
  if (!cfg.bins.codex) throw new Error('CODEX_BIN yok');
  const fp = binFingerprint(cfg.bins.codex);
  const details = {};
  const verified = { ro: false, rw: false, rw_git: false, rw_net: false, review: false };
  const finish = (version = 'unknown') => {
    const record = { fp, context: sandboxContext(cfg), version, at: Date.now(), profiles_verified: verified, details };
    if (fp && o.writeRecord !== false) {
      fs.mkdirSync(lay.caps, { recursive: true, mode: 0o700 });
      writeJsonAtomic(sandboxRecordPath(lay.caps, fp), record);
    }
    return { record, details };
  };
  // Codex file access is not offered on Windows; consultations without a workdir need no profile.
  if (process.platform === 'win32') {
    for (const mode of Object.keys(verified)) details[mode] = "Windows'ta dosya erişimi bu sürümde desteklenmiyor; dosyasız danışma kullanılabilir.";
    return finish();
  }
  const tag = randomBytes(4).toString('hex');
  sweepStaleVerifications(lay.tmp);
  const base = path.join(lay.tmp, `verify-${tag}`);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const controlHome = path.join(base, 'codexhome');
  fs.mkdirSync(controlHome, { mode: 0o700 });
  const userCfg = path.join(cfg.codexHome, 'config.toml');
  // The user's config, without login restrictions (the mock takes a dummy key) and without anything
  // that may hold a credential: this directory is readable by sub-agents.
  if (fs.existsSync(userCfg)) {
    fs.writeFileSync(path.join(controlHome, 'config.toml'), sanitizedCodexConfig(fs.readFileSync(userCfg, 'utf8')), { mode: 0o600 });
  }
  const canary = path.join(base, 'canary-secret.txt');
  fs.writeFileSync(canary, `CANARY-${tag}\n`, { mode: 0o600 });
  const net = await localServer();
  let version = 'unknown';
  let script = '';
  let scriptWorkdir = base;
  let runStart = 0;
  const mock = await startMockResponses(({ index }) => (index === runStart ? { js: `const r = await tools.exec_command(${JSON.stringify({cmd:script,workdir:scriptWorkdir,login:false,tty:false,yield_time_ms:20000})}); text(r.output);` } : { text: 'bitti' }));
  try {
    const srcEnv = { ...systemEnvironment(), HOME: cfg.userHome, PATH: cfg.userPath, LANG: 'C.UTF-8', CODEX_HOME: controlHome, CODEX_API_KEY: 'dummy', NO_PROXY: '127.0.0.1,localhost' };
    const cfgV = { ...cfg, codexHome: controlHome, childEnvPass: ['CODEX_API_KEY'] };
    const controlEnv = buildChildEnv(cfgV, srcEnv, { target: 'codex', jobId: 'verify', tmpDir: base, cliBin: cfg.bins.codex }).env;
    const caps = codexCaps(cfgV, lay.caps, controlEnv);
    if ('error' in caps) throw new Error(caps.error);
    version = caps.version;
    const modes = [
      { key: 'ro', kind: 'ro', git: false, net: false },
      { key: 'rw', kind: 'rw', git: false, net: false },
      { key: 'rw_git', kind: 'rw', git: true, net: false },
      { key: 'rw_net', kind: 'rw', git: false, net: true },
      // The read profile once more, through Codex's reviewer (`exec review`), in a repository with a change.
      { key: 'review', kind: 'ro', git: false, net: false, review: true },
    ];
    for (const m of modes) {
      if (o.modes && !o.modes.includes(m.key)) continue;
      const W = path.join(base, `w-${m.key}`);
      scriptWorkdir = W;
      const JT = path.join(base, `t-${m.key}`);
      fs.mkdirSync(W, { mode: 0o700 });
      fs.mkdirSync(JT, { mode: 0o700 });
      fs.writeFileSync(path.join(W, 'existing.txt'), 'x\n');
      const g = (args, cwd = W) => spawnSync(cfg.bins.git ?? 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: cfg.userPath || process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1' }, windowsHide: true });
      if (m.git || m.review) {
        g(['init', '-q']);
        g(['add', '-A']);
        g(['commit', '-q', '-m', 'init']);
        if (m.review) fs.appendFileSync(path.join(W, 'existing.txt'), 'y\n');
      }
      // A nested repository (vendored library): its hooks/config must stay read-only in every write mode.
      const nested = path.join(W, 'vendor', 'lib');
      if (m.kind === 'rw') {
        fs.mkdirSync(nested, { recursive: true });
        g(['init', '-q'], nested);
      }
      const nestedConfig = m.kind === 'rw' ? fs.readFileSync(path.join(nested, '.git', 'config'), 'utf8') : '';
      const slashProbe = path.join('/tmp', `clivoxa-probe-${tag}-${m.key}`);
      // Writes outside the workdir: its parent and the user's home (both must fail in every mode).
      const homeProbe = path.join(cfg.userHome, `.clivoxa-probe-${tag}-${m.key}`);
      const program = `
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const http = require('node:http');
        const attempt = (label, fn) => { try { fn(); console.log(label + '=0'); } catch (error) { console.log(label + '=1:' + (error.code || 'error')); } };
        const canonical = value => fs.realpathSync.native(value);
        console.log('CWD_MATCH=' + (canonical(process.cwd())===canonical(${JSON.stringify(W)})));
        console.log('CWD_PATH=' + process.cwd().replace(/\\\\/g, '/'));
        attempt('W', () => fs.writeFileSync('ok.txt', 'ok'));
        attempt('WA', () => fs.writeFileSync(${JSON.stringify(path.join(W, 'absolute-ok.txt'))}, 'ok'));
        attempt('C', () => { fs.mkdirSync('.claude', {recursive:true}); fs.writeFileSync('.claude/x', 'x'); });
        attempt('X', () => { fs.mkdirSync('.codex', {recursive:true}); fs.writeFileSync('.codex/config.toml', 'x'); });
        // Absolute twins: protection checks inspect W, so they must not pass merely because cwd differs.
        attempt('CA', () => { fs.mkdirSync(${JSON.stringify(path.join(W, '.claude'))}, {recursive:true}); fs.writeFileSync(${JSON.stringify(path.join(W, '.claude', 'x'))}, 'x'); });
        attempt('XA', () => { fs.mkdirSync(${JSON.stringify(path.join(W, '.codex'))}, {recursive:true}); fs.writeFileSync(${JSON.stringify(path.join(W, '.codex', 'config.toml'))}, 'x'); });
        ${m.git ? `attempt('G', () => cp.execFileSync(${JSON.stringify(cfg.bins.git ?? 'git')}, ['-c','user.email=t@t','-c','user.name=t','-c','commit.gpgsign=false','commit','-q','--allow-empty','-m','probe']));
        attempt('H', () => fs.writeFileSync('.git/hooks/probe','x'));
        attempt('K', () => fs.appendFileSync('.git/config','\\nx\\n'));
        attempt('HA', () => fs.writeFileSync(${JSON.stringify(path.join(W, '.git', 'hooks', 'probe'))},'x'));
        attempt('KA', () => fs.appendFileSync(${JSON.stringify(path.join(W, '.git', 'config'))},'\\nx\\n'));` : `attempt('GN', () => { fs.mkdirSync('.git',{recursive:true}); fs.writeFileSync('.git/x','x'); });
        attempt('GA', () => { fs.mkdirSync(${JSON.stringify(path.join(W, '.git'))},{recursive:true}); fs.writeFileSync(${JSON.stringify(path.join(W, '.git', 'x'))},'x'); });`}
        ${m.kind === 'rw' ? `attempt('NH', () => fs.writeFileSync('vendor/lib/.git/hooks/probe','x'));
        attempt('NK', () => fs.appendFileSync('vendor/lib/.git/config','\\nx\\n'));
        attempt('NA', () => fs.writeFileSync(${JSON.stringify(path.join(nested, '.git', 'hooks', 'probe'))},'x'));
        attempt('NC', () => fs.appendFileSync(${JSON.stringify(path.join(nested, '.git', 'config'))},'\\nx\\n'));` : ''}
        ${m.git && process.platform === 'darwin' ? `attempt('CD', () => fs.writeFileSync('.git/commondir','../../evil'));` : ''}
        attempt('S', () => console.log(fs.readFileSync(${JSON.stringify(canary)},'utf8')));
        attempt('T', () => fs.writeFileSync(${JSON.stringify(slashProbe)},'x'));
        attempt('O', () => fs.writeFileSync('../outside-probe','x'));
        attempt('OA', () => fs.writeFileSync(${JSON.stringify(path.join(base, 'outside-probe'))},'x'));
        attempt('HM', () => fs.writeFileSync(${JSON.stringify(homeProbe)},'x'));
        attempt('D', () => fs.writeFileSync(require('node:path').join(process.env.TMPDIR,'tmp-ok'),'x'));
        const nestedSource = ${JSON.stringify([
          `const {loadConfig}=await import(${JSON.stringify(pathToFileURL(path.join(DIST,'config','config.js')).href)});`,
          `const {startupGuards}=await import(${JSON.stringify(pathToFileURL(path.join(DIST,'security','guards.js')).href)});`,
          "console.log('NESTED_GUARD='+Boolean(startupGuards(loadConfig())));"
        ].join('\n'))};
        const nested = cp.spawnSync(${JSON.stringify(cfg.bins.node)}, ['--input-type=module','-e',nestedSource], {
          cwd: require('node:path').parse(process.cwd()).root,
          env: { PATH:process.env.PATH, HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE, SystemRoot:process.env.SystemRoot, CLIVOXA_EXPOSE:'claude' },
          encoding:'utf8',timeout:10000,stdio:['ignore','inherit','inherit']
        });
        console.log('NESTED_STATUS='+nested.status);
        const q = http.get('http://127.0.0.1:${net.port}/', r => {
          let data=''; r.on('data',d=>data+=d); r.on('end',()=>{console.log(data); console.log('N');});
        });
        q.setTimeout(4000,()=>q.destroy());
        q.on('error',()=>{console.log('N');});
      `;
      script = probeCommand(cfg.bins.node, program, W);

      // Exactly what the runner builds for this workdir (git layout included).
      const layoutW = m.kind === 'rw' ? gitLayout(W) : null;
      const opts = { kind: m.kind, gitWrite: m.git, network: m.net, allowSlashTmp: false, ...(layoutW ? { git: { readOnly: gitReadOnly(W, layoutW, m.git), topWritable: layoutW.topIsDir } } : {}) };
      // Same TOML as production, plus the canary in the deny list (never touches real secrets).
      let toml = profileToml(cfg, opts).replace('filesystem={', `filesystem={${JSON.stringify(canary)}="deny",`);
      if (o.mutateToml) toml = o.mutateToml(m.key, toml); // tests only: negative controls
      const env = buildChildEnv(cfgV, srcEnv, { target: 'codex', jobId: `verify-${m.key}`, tmpDir: JT, cliBin: cfg.bins.codex }).env;
      const iso = isolateMcp(cfg, path.join(base, 'caps'), env, W, caps);
      if ('error' in iso) {
        details[m.key] = `mcp: ${iso.error}`;
        continue;
      }
      const argv = buildCodexArgv({
        mode: 'new', access: m.kind === 'ro' ? 'read' : 'write', shell: true, web: 'off', cwd: W, answerFile: path.join(base, `answer-${m.key}.md`),
        model: cfg.codexModel || 'gpt-6-astra', effort: 'low', jobId: `verify-${m.key}`, sandbox: { kind: 'profiles', name: profileName(opts), toml },
        mcpOverride: iso.override, features: caps, allowSlashTmp: false, netOpen: m.net, review: !!m.review,
        extra: [
          '-c', `openai_base_url=${JSON.stringify(mock.baseUrl)}`, '-c', 'model_provider="openai"',
        ],
      });
      const before = mock.requests.length;
      runStart = mock.requests.filter((q) => q.method === 'POST' && /\/responses/.test(q.url ?? '')).length;
      const l = resolveLaunch(cfg, cfg.bins.codex);
      const r = await runCodex(l.cmd, [...l.pre, ...argv], env, W, 'clivoxa sandbox doğrulaması');
      const outputs = mock.requests.slice(before).flatMap((q) => (q.body?.input ?? []).filter((i) => /output/.test(i?.type ?? '')).map((i) => JSON.stringify(i.output)));
      const out = outputs.join('\n').replace(/\\n/g, '\n');
      const has = (p) => fs.existsSync(path.join(W, p));
      const checks = {};
      if (r.code !== 0 || !/W=\d/.test(out)) {
        const shown = out.replace(/\s+/g, ' ').trim().slice(0, 400);
        details[m.key] = `codex çalışmadı (çıkış ${r.code}): ${(r.err || '').split('\n').filter((x) => !/websocket/i.test(x)).slice(-5).join(' | ').slice(0, 400)}${shown ? ` | çıktı: ${shown}` : ''}`;
        continue;
      }
      checks.write = m.kind === 'rw' ? has('ok.txt') : !has('ok.txt');
      checks.absolute_write = m.kind === 'rw' ? has('absolute-ok.txt') : !has('absolute-ok.txt');
      checks.cwd = /CWD_MATCH=true\b/.test(out);
      checks.claude_protected = !has('.claude/x');
      checks.codex_protected = !has('.codex/config.toml');
      if (m.git) {
        const head = spawnSync(cfg.bins.git ?? 'git', ['rev-list', '--count', 'HEAD'], { cwd: W, encoding: 'utf8', windowsHide: true }).stdout.trim();
        checks.git_commit = head === '2';
        checks.hooks_protected = !has('.git/hooks/probe');
        checks.config_protected = !fs.readFileSync(path.join(W, '.git', 'config'), 'utf8').includes('\nx\n');
        // macOS denies creating it; on Linux a placeholder would break git, so the post-job scan removes it instead.
        if (process.platform === 'darwin') checks.commondir_protected = !has('.git/commondir');
      } else {
        checks.git_create_protected = !has('.git/x');
      }
      if (m.kind === 'rw') {
        checks.nested_git_protected = !fs.existsSync(path.join(nested, '.git', 'hooks', 'probe')) && fs.readFileSync(path.join(nested, '.git', 'config'), 'utf8') === nestedConfig;
        // The ro profile does not grant TMPDIR; every write profile must (npm, git and compilers need it).
        checks.tmpdir_writable = /(^|\n)"?D=0\b/.test(out) && fs.existsSync(path.join(JT, 'tmp-ok'));
      }
      checks.secret_denied = !out.includes(`CANARY-${tag}`);
      checks.slash_tmp_denied = !fs.existsSync(slashProbe);
      checks.outside_denied = !fs.existsSync(path.join(base, 'outside-probe')) && !fs.existsSync(homeProbe);
      checks.network = m.net ? out.includes('NETOK') : !out.includes('NETOK');
      checks.loop_refused = /NESTED_GUARD=true\b/.test(out) && /NESTED_STATUS=0\b/.test(out);
      rmrf(slashProbe);
      rmrf(homeProbe);
      rmrf(path.join(base, 'outside-probe'));
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      if (o.debug) log(JSON.stringify({mode:m.key,checks,output:out}));
      verified[m.key] = failed.length === 0;
      const markers = out.match(/\b[A-Z]{1,2}=[01](?::[A-Z_]+)?\b/g) ?? [];
      details[m.key] = failed.length ? `başarısız: ${failed.join(', ')}; probes: ${markers.join(', ')}; cwd_matches=${checks.cwd}` : 'ok';
      log(`  ${m.key}: ${details[m.key]}`);
    }
  } finally {
    await mock.close();
    await net.close();
    rmrf(base);
  }
  return finish(version);
}
