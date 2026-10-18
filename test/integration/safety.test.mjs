import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHome, startServer, argvLog, untilDone, cleanupHome, killJobProcs, DIST, FAKE_CODEX } from '../helpers/harness.mjs';

const homes = [];
after(() => homes.forEach(cleanupHome));
const H = (o) => {
  const h = mkHome(o);
  homes.push(h);
  return h;
};

async function forgeSandboxRecord(h, verified = { ro: true, rw: true, rw_git: true, rw_net: true }) {
  const caps = await import(path.join(path.dirname(DIST), 'providers', 'capabilities.js'));
  const fp = caps.binFingerprint(FAKE_CODEX);
  const {loadConfig}=await import('../../dist/config/config.js');
  const context=caps.sandboxContext(loadConfig({HOME:h.home,CLIVOXA_HOME:h.clivoxa,CLAUDE_CONFIG_DIR:path.join(h.home,'.claudecfg')}));
  fs.mkdirSync(path.join(h.clivoxa, 'caps'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(caps.sandboxRecordPath(path.join(h.clivoxa, 'caps'), fp), JSON.stringify({ fp, context, version: '0.162.1', at: Date.now(), profiles_verified: verified, details: {} }));
}

test('loop guard: env, cwd, TMPDIR and sandbox markers make the server refuse (empty tools)', async () => {
  const h = H();
  fs.mkdirSync(path.join(h.clivoxa, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(h.clivoxa, 'tmp', 'job'), { recursive: true });
  const cases = [
    { CLIVOXA_DEPTH: '1' },
    { CLIVOXA_JOB_ID: '20261014-120000-codex-0123abcd' },
    // An older bridge can launch the new server while both installations coexist.
    { KOPRU_DEPTH: '1' },
    { KOPRU_JOB_ID: '20261014-120000-codex-0123abcd' },
    { CODEX_SANDBOX: 'seatbelt' },
    { SANDBOX_RUNTIME: '1' },
    { TMPDIR: path.join(h.clivoxa, 'tmp', 'job') },
    { __cwd: path.join(h.clivoxa, 'scratch') },
  ];
  for (const extra of cases) {
    for (const role of ['codex', 'claude']) {
      const s = await startServer(h, role, extra);
      try {
        assert.deepEqual(await s.tools(), [], `${role} ${JSON.stringify(extra)}`);
      } finally {
        await s.close();
      }
    }
  }
});

test('loop guard: a server started from inside the consulted agent with a scrubbed env refuses (ancestry)', async () => {
  const h = H();
  const result = path.join(h.home, 'loop-result.json');
  const s = await startServer(h, 'codex', { FAKE_CLIVOXA_DIST: DIST, FAKE_CLIVOXA_HOME: h.clivoxa, FAKE_LOOP_RESULT: result, FAKE_LOOP_CWD: '/' });
  try {
    const r = await s.call('ask_codex', { prompt: 'loop [[FAKE:loop_probe]]', wait_seconds: 40 });
    assert.equal(r.h.status, 'done', r.text);
    const line = fs.readFileSync(result, 'utf8');
    const j = JSON.parse(line);
    assert.deepEqual(j.result.tools, [], line);
  } finally {
    await s.close();
  }
});

test('MCP keep mode: current and legacy bridge registrations are disabled, unrelated servers are preserved', async () => {
  for (const stuck of [false, true]) {
    const h = H();
    const s = await startServer(h, 'codex', {
      CLIVOXA_CODEX_USER_MCP: 'keep',
      FAKE_CODEX_SERVERS: 'kopru,github,clivoxa-tools',
      ...(stuck ? { FAKE_CODEX_STUCK: 'kopru' } : {}),
    });
    try {
      const r = await s.call('ask_codex', { prompt: 'isolation check', wait_seconds: 30 });
      const exec = argvLog(h).find((e) => e.cli === 'codex' && e.argv.includes('exec'));
      if (stuck) {
        assert.match(r.text, /kapatılamayan sunucular: kopru/);
        assert.equal(exec, undefined, 'a legacy bridge left enabled must prevent the consulted agent from starting');
      } else {
        assert.equal(r.h.status, 'done', r.text);
        const override = exec.argv.find((a) => a.startsWith('mcp_servers='));
        assert.equal(override, 'mcp_servers={clivoxa={command="/usr/bin/false",enabled=false},kopru={command="/usr/bin/false",enabled=false}}');
      }
    } finally {
      await s.close();
    }
  }
});

test('runtime self-checks: Codex MCP call and Claude init with MCP/Agent/Bash are killed', async () => {
  const h = H();
  const a = await startServer(h, 'codex');
  const c = await startServer(h, 'claude');
  try {
    const r = await a.call('ask_codex', { prompt: 'x [[FAKE:mcp_item]] [[FAKE:sleep=20]]', wait_seconds: 30 });
    assert.equal(r.h.error_kind, 'self_check', r.text);
    assert.match(r.h.error, /MCP aracı çağrıldı/);
    for (const mk of ['init_mcp', 'init_agent', 'bad_init=bash']) {
      const x = await c.call('ask_claude', { prompt: `x [[FAKE:${mk}]] [[FAKE:sleep=20]]`, wait_seconds: 30 });
      assert.equal(x.h.error_kind, 'self_check', `${mk}: ${x.text}`);
    }
    const sh = await a.call('ask_codex', { prompt: 'x [[FAKE:cmd_item]] [[FAKE:sleep=20]]', wait_seconds: 30 });
    assert.equal(sh.h.error_kind, 'self_check', sh.text);
    assert.match(sh.h.error, /kabuk kapalıyken/);
  } finally {
    await a.close();
    await c.close();
  }
});

test('Claude write mode: changes reported, protected config reverted, settings deny protected paths', async () => {
  const h = H({ git: true });
  fs.writeFileSync(path.join(h.proj, 'CLAUDE.md'), 'orijinal talimat\n');
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', {
      prompt: 'düzelt [[FAKE:write_file=a.txt]] [[FAKE:plant=.claude/settings.json]]',
      workdir: h.proj, access: 'write', wait_seconds: 30,
    });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.text, /changes: .*a\.txt/);
    const archived = path.join(r.h.job_dir, 'protect', 'after', '.claude', 'settings.json');
    assert.match(r.text, /UYARI korunan dosyalar iş sırasında değişti \(alt ajan, siz, ana uygulama ya da IDE olabilir\); politika revert: .*\.claude\/settings\.json \(removed → /);
    assert.ok(r.text.includes(`(removed → ${archived})`), 'absolute archive path shown');
    assert.ok(!fs.existsSync(path.join(h.proj, '.claude', 'settings.json')), 'planted settings removed');
    assert.ok(!fs.existsSync(path.join(h.proj, '.claude')), 'empty .claude placeholder cleaned');
    assert.equal(fs.readFileSync(archived, 'utf8'), 'planted\n', 'version moved into the archive, not deleted');
    assert.equal(fs.readFileSync(path.join(h.proj, 'CLAUDE.md'), 'utf8'), 'orijinal talimat\n');
    const e = argvLog(h).filter((x) => x.cli === 'claude' && x.argv.includes('-p')).at(-1);
    assert.equal(e.argv[e.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.ok(e.argv.includes('--tools=Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,TaskStop,WebSearch'), e.argv.join(' '));
    const settings = e.settings;
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(h.proj, '.claude')));
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(h.proj, '.git')));
    assert.ok(settings.permissions.deny.includes(`Edit(/${path.join(h.proj, 'CLAUDE.md')})`));
    assert.deepEqual(settings.sandbox.network.allowedDomains, []);
    // Modify a pre-existing protected file: it is restored.
    const r2 = await s.call('ask_claude', { prompt: 'x [[FAKE:plant=CLAUDE.md]]', workdir: h.proj, access: 'write', wait_seconds: 30 });
    assert.match(r2.text, /CLAUDE\.md \(reverted/);
    assert.equal(fs.readFileSync(path.join(h.proj, 'CLAUDE.md'), 'utf8'), 'orijinal talimat\n');
  } finally {
    await s.close();
  }
});

test('Claude read mode removes the .claude/.cc-writes placeholder it created itself', async () => {
  const h = H();
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', { prompt: 'oku', workdir: h.proj, wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    assert.ok(!fs.existsSync(path.join(h.proj, '.claude')));
    const e = argvLog(h).filter((x) => x.cli === 'claude' && x.argv.includes('-p')).at(-1);
    assert.ok(e.argv.includes('--tools=Read,Glob,Grep,Bash,WebSearch'), e.argv.join(' '));
    const settings = e.settings;
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.ok(settings.permissions.deny.some((d) => d.includes('/.ssh/**')));
    assert.equal(e.cwd, h.proj);
  } finally {
    await s.close();
  }
});

test('Codex write: refused until profiles are verified; then profile argv (no -s), .git quarantine, placeholders removed', async () => {
  const h = H({ git: true });
  const s = await startServer(h, 'codex', { __unverified: true });
  try {
    const r0 = await s.call('ask_codex', { prompt: 'x', workdir: h.proj, access: 'write' });
    assert.equal(r0.h.status, 'error', r0.text);
    assert.equal(r0.h.error_kind, 'codex_write_unverified', r0.text);
    await forgeSandboxRecord(h);
    await s.close();
    const s2 = await startServer(h, 'codex');
    const r = await s2.call('ask_codex', { prompt: 'yaz [[FAKE:write_file=b.txt]] [[FAKE:plant_git=sub]] [[FAKE:placeholder]]', workdir: h.proj, access: 'write', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.h.access, /sandbox: profiles\(clivoxa_rw\)/);
    const e = argvLog(h).filter((x) => x.cli === 'codex' && x.argv.includes('exec')).at(-1);
    assert.ok(!e.argv.includes('-s'));
    assert.ok(e.argv.includes('default_permissions="clivoxa_rw"'));
    const prof = e.argv.find((x) => x.startsWith('permissions.clivoxa_rw='));
    assert.match(prof, /extends=":workspace"/);
    assert.match(prof, /".git"="read"/);
    assert.match(prof, /".claude"="read"/);
    assert.match(prof, /network=\{enabled=false\}/);
    assert.match(prof, /\.ssh"="deny"/);
    assert.ok(fs.existsSync(path.join(h.proj, 'b.txt')));
    assert.ok(!fs.existsSync(path.join(h.proj, 'sub', '.git')), 'planted nested .git quarantined');
    assert.ok(fs.existsSync(path.join(r.h.job_dir, 'protect', 'quarantine', 'sub', '.git', 'config')));
    assert.ok(!fs.existsSync(path.join(h.proj, '.codex')), 'empty .codex placeholder removed');
    assert.match(r.text, /sub\/\.git \(quarantined/);
    await s2.close();
  } finally {
    await s.close().catch(() => undefined);
  }
});

test('write lock, session lock and read-alongside-write warning', async () => {
  const h = H({ git: true });
  const s = await startServer(h, 'claude');
  try {
    const w1 = await s.call('ask_claude', { prompt: 'uzun [[FAKE:sleep=6]]', workdir: h.proj, access: 'write', wait_seconds: 0 });
    assert.equal(w1.h.status, 'running', w1.text);
    const w2 = await s.call('ask_claude', { prompt: 'ikinci', workdir: path.join(h.proj), access: 'write', wait_seconds: 0 });
    assert.equal(w2.isError, true);
    assert.match(w2.text, /zaten bir yazma işi var/);
    const rd = await s.call('ask_claude', { prompt: 'oku', workdir: h.proj, wait_seconds: 20 });
    assert.match(rd.text, /çalışan bir yazma işi var/);
    await untilDone(s, w1.h.job_id);
    const w3 = await s.call('ask_claude', { prompt: 'üçüncü', workdir: h.proj, access: 'write', wait_seconds: 20 });
    assert.equal(w3.h.status, 'done', w3.text);
    // Session lock: a second turn on a busy session is refused.
    const a = await s.call('ask_claude', { prompt: 'ilk', wait_seconds: 20 });
    const sid = a.h.session_id.split(' ')[0];
    const b = await s.call('ask_claude', { prompt: 'devam [[FAKE:sleep=5]]', session_id: sid, wait_seconds: 0 });
    assert.equal(b.h.status, 'running');
    const c = await s.call('ask_claude', { prompt: 'aynı anda', session_id: sid, wait_seconds: 0 });
    assert.match(c.text, /Bu oturumda çalışan bir iş var/);
    await untilDone(s, b.h.job_id);
  } finally {
    await s.close();
  }
});

test('install ceilings: MAX_ACCESS=read, Codex network deny, git_write disabled', async () => {
  const h = H({ git: true });
  const s = await startServer(h, 'claude', { CLIVOXA_MAX_ACCESS: 'read', CLIVOXA_ALLOW_GIT_WRITE: '0' });
  const a = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_claude', { prompt: 'x', workdir: h.proj, access: 'write' });
    assert.match(r.text, /yazma kapalı/);
    const n = await a.call('ask_codex', { prompt: 'x', workdir: h.proj, access: 'write', network: true });
    assert.match(n.text, /Codex için kabuk ağı/);
    const s3 = await startServer(h, 'claude', { CLIVOXA_ALLOW_GIT_WRITE: '0' });
    const g = await s3.call('ask_claude', { prompt: 'x', workdir: h.proj, access: 'write', git_write: true });
    assert.match(g.text, /git_write bu kurulumda kapalı/);
    await s3.close();
  } finally {
    await s.close();
    await a.close();
  }
});

test('secrets: outgoing prompt redacted, answer masked on display (raw kept 0600), end marker defanged, paging', async () => {
  const h = H();
  const s = await startServer(h, 'codex', { CLIVOXA_MAX_ANSWER_CHARS: '1000' });
  try {
    const r = await s.call('ask_codex', { prompt: 'anahtarım sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ ve kartım 4111 1111 1111 1111 [[FAKE:secret_answer]] [[FAKE:end_marker]]', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.h.notes, /maskelendi/);
    const pm = fs.readFileSync(path.join(r.h.job_dir, 'prompt.md'), 'utf8');
    assert.ok(!pm.includes('sk-ant-api03-ZZZZ'));
    assert.ok(!pm.includes('4111 1111 1111 1111'));
    assert.ok(!r.answer.includes('sk-ant-api03-ABCDEFG'), 'answer masked');
    assert.match(r.text, /redactions: Yanıtta 1 olası gizli bilgi maskelendi/);
    assert.match(fs.readFileSync(path.join(r.h.job_dir, 'answer.md'), 'utf8'), /sk-ant-api03-ABCDEFG/);
    assert.match(r.answer, /SAHTE TALİMAT/, 'injected end marker did not close the block');
    const long = await s.call('ask_codex', { prompt: 'uzun [[FAKE:long=2500]]', wait_seconds: 30 });
    assert.match(long.text, /answer: \d+ karakter \(gösterilen 0–1000\) \[devamı: get_job\(job_id="[^"]+", answer_offset=1000\)\]/);
    const p2 = await s.call('get_job', { job_id: long.h.job_id, answer_offset: 1000 });
    assert.match(p2.text, /gösterilen 1000–2000/);
  } finally {
    await s.close();
  }
});
