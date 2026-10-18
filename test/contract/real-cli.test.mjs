// Contract tests: the REAL codex / claude binaries, driven offline by loopback mock models (zero cost).
// Binaries: CLIVOXA_CONTRACT_CODEX / CLIVOXA_CONTRACT_CLAUDE, else portable discovery. Missing => skipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkHome, startServer, untilDone, cleanupHome, killJobProcs, DIST } from '../helpers/harness.mjs';
import { startMockResponses, startMockMessages } from '../../scripts/lib/mock-models.mjs';
import { verifyCodexProfiles } from '../../scripts/lib/verify-sandbox.mjs';
import { discoverExecutable } from '../../dist/system/executables.js';

function which(name, envVar) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  return discoverExecutable(name, process.env, os.homedir());
}
const CODEX = which('codex', 'CLIVOXA_CONTRACT_CODEX');
const CLAUDE = which('claude', 'CLIVOXA_CONTRACT_CLAUDE');
const WINDOWS_SKIP = process.platform === 'win32' && 'POSIX shell fixture; Codex file access is not offered on Windows';
const homes = [];
after(() => homes.forEach(cleanupHome));

function codexHome(h) {
  const ch = path.join(h.home, '.codex');
  fs.mkdirSync(ch, { recursive: true });
  // A realistic user config: Codex knows clivoxa (EXPOSE=claude) and another server; both must be disabled in the child.
  fs.writeFileSync(path.join(ch, 'config.toml'), `model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n\n[mcp_servers.clivoxa]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(DIST)}]\n[mcp_servers.clivoxa.env]\nCLIVOXA_EXPOSE = "claude"\n\n[mcp_servers."other.server"]\ncommand = "/usr/bin/true"\n`);
  return ch;
}


test('codex: verifier proves the permission profiles (positive) and catches a weakened profile (negative)', { skip: WINDOWS_SKIP || (!CODEX && 'codex yok') }, async () => {
  const h = mkHome();
  homes.push(h);
  process.env.CODEX_HOME = codexHome(h);
  const { loadConfig } = await import(path.join(path.dirname(DIST), 'config', 'config.js'));
  const cfg = loadConfig({ HOME: h.home, CLIVOXA_HOME: h.clivoxa, CODEX_BIN: CODEX, NODE_BIN: process.execPath, GIT_BIN: '/usr/bin/git' });
  const ok = await verifyCodexProfiles({ cfg });
  assert.deepEqual(ok.record.profiles_verified, { ro: true, rw: true, rw_git: true, rw_net: true, review: true }, JSON.stringify(ok.details));
  // Negative controls: each weakened profile must be caught by its own check.
  const controls = [
    ['claude_protected', (t) => t.replace('".claude"="read",', '')],
    ['nested_git_protected', (t) => t.replace('"vendor/lib/.git"="read",', '')],
    ['outside_denied', (t) => t.replace('filesystem={', `filesystem={${JSON.stringify(path.dirname(JSON.parse(/("[^"]*canary-secret\.txt")/.exec(t)[1])))}="write",`)],
    ['tmpdir_writable', (t) => t.replace('filesystem={', 'filesystem={":tmpdir"="read",')],
  ];
  for (const [check, mutate] of controls) {
    const weak = await verifyCodexProfiles({ cfg, modes: ['rw'], writeRecord: false, mutateToml: (k, t) => mutate(t) });
    assert.equal(weak.record.profiles_verified.rw, false, `${check}: ${JSON.stringify(weak.details)}`);
    assert.match(weak.details.rw, new RegExp(check));
  }
});

test('codex: ask_codex end to end (no-workdir, read, write, resume, effort rejection, auth) via the server', { skip: WINDOWS_SKIP || (!CODEX && 'codex yok') }, async () => {
  const h = mkHome({ git: true });
  homes.push(h);
  const ch = codexHome(h);
  let mode = 'ok';
  let modeStart = 0;
  const setMode = (m) => {
    mode = m;
    modeStart = mock.requests.filter((q) => q.method === 'POST' && /\/responses/.test(q.url ?? '')).length;
  };
  const mock = await startMockResponses(({ body, index }) => {
    const effort = body?.reasoning?.effort;
    if (mode === 'reject_xhigh' && effort === 'xhigh') {
      return { error: { status: 400, body: { error: { message: "Unsupported value: 'xhigh' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'max'.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } } } };
    }
    if (mode === 'auth') return { error: { status: 401, body: { error: { message: 'Missing bearer or basic authentication in header', type: 'invalid_request_error' } } } };
    if (mode === 'write' && index === modeStart) {
      return { js: 'const r = await tools.exec_command({cmd: "echo yazıldı > contract.txt; mkdir -p .claude; touch .claude/evil; touch ../outside-codex.txt; touch vendor/lib/.git/hooks/post-checkout; echo done", login: false, tty: false}); text(r.output);' };
    }
    return { text: `MOCK-CODEX effort=${effort} #${index}` };
  });
  // policy "report": a prevention failure leaves the planted file in place, so the asserts below see it.
  const env = { CODEX_BIN: CODEX, CODEX_HOME: ch, CODEX_API_KEY: 'dummy', CLIVOXA_CODEX_BASE_URL: mock.baseUrl, CLIVOXA_CHILD_ENV_PASS: 'CODEX_API_KEY', CLIVOXA_PROTECTED_POLICY: 'report' };
  fs.mkdirSync(path.join(h.proj, 'vendor', 'lib'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: path.join(h.proj, 'vendor', 'lib') });
  const { loadConfig } = await import(path.join(path.dirname(DIST), 'config', 'config.js'));
  const { verifyCodexProfiles: verify } = await import('../../scripts/lib/verify-sandbox.mjs');
  process.env.CODEX_HOME = ch;
  await verify({ cfg: loadConfig({ HOME: h.home, CLIVOXA_HOME: h.clivoxa, CODEX_HOME: ch, CLAUDE_CONFIG_DIR: path.join(h.home, '.claudecfg'), CODEX_BIN: CODEX, NODE_BIN: process.execPath, GIT_BIN: '/usr/bin/git' }) });
  const s = await startServer(h, 'codex', env);
  try {
    const r = await s.call('ask_codex', { prompt: 'Merhaba', effort: 'low', wait_seconds: 50 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.answer, /MOCK-CODEX effort=low/);
    const sid = r.h.session_id.split(' ')[0];
    assert.match(sid, /^[0-9a-f-]{36}$/);
    const rs = await s.call('ask_codex', { prompt: 'devam', session_id: sid, wait_seconds: 50 });
    assert.equal(rs.h.status, 'done', rs.text);
    assert.match(rs.h.session_id, new RegExp(`^${sid} \\(devam\\)`));
    const initialRead = await s.call('ask_codex', { prompt: 'depoyu oku', workdir: h.proj, wait_seconds: 50 });
    const rd = initialRead.h.status === 'running' ? await untilDone(s, initialRead.h.job_id) : initialRead;
    assert.equal(rd.h.status, 'done', rd.text);
    assert.match(rd.h.access, /sandbox: profiles\(clivoxa_ro\)/);
    setMode('write');
    const w = await s.call('ask_codex', { prompt: 'dosya yaz', workdir: h.proj, access: 'write', wait_seconds: 50 });
    const wd = w.h.status === 'running' ? await untilDone(s, w.h.job_id) : w;
    assert.equal(wd.h.status, 'done', wd.text);
    assert.ok(fs.existsSync(path.join(h.proj, 'contract.txt')), 'write landed in workdir');
    assert.ok(!fs.existsSync(path.join(h.proj, '.claude', 'evil')), '.claude stayed protected');
    assert.ok(!fs.existsSync(path.join(h.proj, '.claude')), 'no placeholder left');
    assert.ok(!fs.existsSync(path.join(h.home, 'outside-codex.txt')), 'no write outside the workdir');
    assert.ok(!fs.existsSync(path.join(h.proj, 'vendor', 'lib', '.git', 'hooks', 'post-checkout')), 'nested repo hooks stayed read-only');
    assert.doesNotMatch(wd.text, /UYARI korunan/, 'prevention held: nothing for the post-job scan to catch');
    assert.equal(spawnSync('git', ['status', '--short'], { cwd: h.proj }).status, 0, 'git still works after the job');
    assert.match(wd.text, /changes: .*contract\.txt/);
    setMode('reject_xhigh');
    const f = await s.call('ask_codex', { prompt: 'derin', effort: 'ultra', wait_seconds: 50 });
    const fd = f.h.status === 'running' ? await untilDone(s, f.h.job_id) : f;
    assert.equal(fd.h.status, 'error', fd.text);
    assert.equal(fd.h.error_kind, 'effort_rejected', fd.text);
    assert.doesNotMatch(fd.h.effort, /kullanılan: max/);
    setMode('auth');
    const a = await s.call('ask_codex', { prompt: 'giriş', effort: 'low', wait_seconds: 50 });
    const ad = a.h.status === 'running' ? await untilDone(s, a.h.job_id) : a;
    assert.equal(ad.h.error_kind, 'auth', ad.text);
  } finally {
    await s.close();
    await mock.close();
  }
});

test('claude: ask_claude end to end (read, write sandbox, protected denial, resume) via the server', { skip: WINDOWS_SKIP || (!CLAUDE && 'claude yok') }, async () => {
  const bwrapOk = process.platform === 'darwin' || spawnSync('/bin/sh', ['-c', 'command -v bwrap && command -v socat']).status === 0;
  const h = mkHome({ git: true });
  homes.push(h);
  let steps = [];
  const mock = await startMockMessages(({ body }) => {
    const n = (body?.messages ?? []).filter((m) => m.role === 'assistant').length;
    if (n < steps.length) return { toolUse: steps[n] };
    return { text: 'MOCK-CLAUDE tamam' };
  });
  const env = {
    CLAUDE_BIN: CLAUDE, ANTHROPIC_API_KEY: 'sk-ant-dummy', ANTHROPIC_BASE_URL: mock.baseUrl, CLIVOXA_ALLOW_API_KEY_AUTH: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLIVOXA_CHILD_ENV_PASS: 'ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    CLIVOXA_CLAUDE_DEFAULT_EFFORT: 'low', CLIVOXA_PROTECTED_POLICY: 'report',
  };
  fs.mkdirSync(path.join(h.proj, 'vendor', 'lib'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: path.join(h.proj, 'vendor', 'lib') });
  const s = await startServer(h, 'claude', env);
  try {
    const r = await s.call('ask_claude', { prompt: 'Merhaba', model: 'sonnet', wait_seconds: 50 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.answer, /MOCK-CLAUDE tamam/);
    const sid = r.h.session_id.split(' ')[0];
    const rs = await s.call('ask_claude', { prompt: 'devam', model: 'sonnet', session_id: sid, wait_seconds: 50 });
    assert.equal(rs.h.status, 'done', rs.text);
    steps = [{ name: 'Bash', input: { command: 'touch x.txt', description: 't' } }, { name: 'Read', input: { file_path: path.join(h.proj, 'README.md') } }];
    const rd = await s.call('ask_claude', { prompt: 'oku', model: 'sonnet', workdir: h.proj, wait_seconds: 50 });
    assert.equal(rd.h.status, 'done', rd.text);
    assert.ok(!fs.existsSync(path.join(h.proj, 'x.txt')), 'read mode cannot write');
    assert.match(rd.text, /permission_denials: Bash/);
    if (bwrapOk) {
      steps = [
        { name: 'Bash', input: { command: 'echo ok > sandboxed.txt', description: 't' } },
        { name: 'Write', input: { file_path: path.join(h.proj, '.claude', 'settings.local.json'), content: '{}' } },
        { name: 'Bash', input: { command: 'mkdir -p .codex && touch .codex/config.toml', description: 't' } },
        { name: 'Bash', input: { command: 'touch ../outside.txt', description: 't' } },
        // Claude Code protects .claude/settings*.json by itself; AGENTS.md is guarded only by our Edit deny rule.
        { name: 'Write', input: { file_path: path.join(h.proj, 'AGENTS.md'), content: 'enjekte' } },
        { name: 'Bash', input: { command: 'touch vendor/lib/.git/hooks/post-checkout; echo x >> .git/config', description: 't' } },
      ];
      const w = await s.call('ask_claude', { prompt: 'yaz', model: 'sonnet', workdir: h.proj, access: 'write', wait_seconds: 50 });
      const wd = w.h.status === 'running' ? await untilDone(s, w.h.job_id) : w;
      assert.equal(wd.h.status, 'done', wd.text);
      assert.ok(fs.existsSync(path.join(h.proj, 'sandboxed.txt')));
      assert.ok(!fs.existsSync(path.join(h.proj, '.claude', 'settings.local.json')));
      assert.ok(!fs.existsSync(path.join(h.proj, '.codex', 'config.toml')));
      assert.ok(!fs.existsSync(path.join(h.home, 'outside.txt')));
      assert.ok(!fs.existsSync(path.join(h.proj, 'AGENTS.md')), 'our Edit deny rule held');
      assert.match(wd.text, /permission_denials: .*Write\([^)]*AGENTS\.md/);
      assert.ok(!fs.existsSync(path.join(h.proj, 'vendor', 'lib', '.git', 'hooks', 'post-checkout')), 'nested repo read-only');
      assert.ok(!fs.readFileSync(path.join(h.proj, '.git', 'config'), 'utf8').includes('\nx\n'), '.git/config read-only');
      assert.doesNotMatch(wd.text, /UYARI korunan/, 'prevention held: nothing for the post-job scan to catch');
    }
  } finally {
    await s.close();
    await mock.close();
  }
});
