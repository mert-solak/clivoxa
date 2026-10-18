// Write-mode protection: nested repositories, never-destroy revert, host/IDE-managed paths, canonical archive paths.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkHome, startServer, argvLog, cleanupHome, killJobProcs, untilDone, DIST, FAKE_CODEX } from '../helpers/harness.mjs';

const homes = [];
after(() => homes.forEach(cleanupHome));
const H = (o) => {
  const h = mkHome(o);
  homes.push(h);
  return h;
};
const git = (cwd, args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });

function nestedRepo(h) {
  const lib = path.join(h.proj, 'vendor', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  git(lib, ['init', '-q']);
  return lib;
}

async function forgeSandboxRecord(h) {
  const caps = await import(path.join(path.dirname(DIST), 'providers', 'capabilities.js'));
  const fp = caps.binFingerprint(FAKE_CODEX);
  const {loadConfig}=await import('../../dist/config/config.js');
  const context=caps.sandboxContext(loadConfig({HOME:h.home,CLIVOXA_HOME:h.clivoxa,CLAUDE_CONFIG_DIR:path.join(h.home,'.claudecfg')}));
  fs.mkdirSync(path.join(h.clivoxa, 'caps'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(caps.sandboxRecordPath(path.join(h.clivoxa, 'caps'), fp), JSON.stringify({ fp, context, version: '0.162.1', at: Date.now(), profiles_verified: { ro: true, rw: true, rw_git: true, rw_net: true }, details: {} }));
}

test('Claude write: nested repo is read-only in settings and its hooks/config are reverted; host-managed and big files never lost', async () => {
  const h = H({ git: true });
  const lib = nestedRepo(h);
  const libConfig = fs.readFileSync(path.join(lib, '.git', 'config'), 'utf8');
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', {
      prompt: 'x [[FAKE:plant=vendor/lib/.git/hooks/pre-commit]] [[FAKE:plant=vendor/lib/.git/config]] [[FAKE:plant=.claude/settings.local.json]] [[FAKE:big_plant=.idea/big.xml]] [[FAKE:plant=.git/commondir]]',
      workdir: h.proj, access: 'write', wait_seconds: 30,
    });
    assert.equal(r.h.status, 'done', r.text);
    const e = argvLog(h).filter((x) => x.cli === 'claude' && x.argv.includes('-p')).at(-1);
    const settings = e.settings;
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(lib, '.git')), JSON.stringify(settings.sandbox.filesystem.denyWrite));
    assert.ok(settings.permissions.deny.includes(`Edit(/${path.join(lib, '.git')}/**)`));
    // Backstop: the nested hook is moved into the archive, the nested config restored.
    assert.ok(!fs.existsSync(path.join(lib, '.git', 'hooks', 'pre-commit')));
    assert.equal(fs.readFileSync(path.join(lib, '.git', 'config'), 'utf8'), libConfig);
    assert.ok(fs.existsSync(path.join(r.h.job_dir, 'protect', 'after', 'vendor', 'lib', '.git', 'hooks', 'pre-commit')));
    assert.match(r.text, /vendor\/lib\/\.git\/config \(reverted/);
    // A planted commondir would redirect git: removed (top-level git internals are watched too).
    assert.ok(!fs.existsSync(path.join(h.proj, '.git', 'commondir')));
    assert.equal(git(h.proj, ['status', '--short']).status, 0, 'git still works');
    // Host/IDE-managed: reported, left in place.
    assert.match(r.text, /\.claude\/settings\.local\.json \(reported\)/);
    assert.equal(fs.readFileSync(path.join(h.proj, '.claude', 'settings.local.json'), 'utf8'), 'planted\n');
    // A new file over 1 MB is archived in full (the old code deleted it without a copy).
    assert.ok(!fs.existsSync(path.join(h.proj, '.idea', 'big.xml')));
    assert.equal(fs.statSync(path.join(r.h.job_dir, 'protect', 'after', '.idea', 'big.xml')).size, 2 * 1024 * 1024);
  } finally {
    await s.close();
  }
});

test('Claude write with git_write: top-level internals stay read-only, nested repo stays read-only', async () => {
  const h = H({ git: true });
  const lib = nestedRepo(h);
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', { prompt: 'commit', workdir: h.proj, access: 'write', git_write: true, wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    const e = argvLog(h).filter((x) => x.cli === 'claude' && x.argv.includes('-p')).at(-1);
    const deny = e.settings.sandbox.filesystem.denyWrite;
    assert.ok(!deny.includes(path.join(h.proj, '.git')), 'own repo writable');
    for (const p of ['.git/hooks', '.git/config', '.git/info']) assert.ok(deny.includes(path.join(h.proj, p)), p);
    assert.ok(deny.includes(path.join(lib, '.git')), 'nested repo read-only even with git_write');
  } finally {
    await s.close();
  }
});

test('Codex write: nested repo read-only in the profile; git_write keeps internals read-only; planted nested hook reverted', async () => {
  const h = H({ git: true });
  nestedRepo(h);
  await forgeSandboxRecord(h);
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'x [[FAKE:plant=vendor/lib/.git/hooks/post-checkout]]', workdir: h.proj, access: 'write', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    let prof = argvLog(h).filter((x) => x.cli === 'codex' && x.argv.includes('exec')).at(-1).argv.find((x) => x.startsWith('permissions.'));
    assert.match(prof, /".git"="read"/);
    assert.match(prof, /"vendor\/lib\/\.git"="read"/);
    assert.ok(!fs.existsSync(path.join(h.proj, 'vendor', 'lib', '.git', 'hooks', 'post-checkout')));
    const g = await s.call('ask_codex', { prompt: 'commit', workdir: h.proj, access: 'write', git_write: true, wait_seconds: 30 });
    assert.equal(g.h.status, 'done', g.text);
    prof = argvLog(h).filter((x) => x.cli === 'codex' && x.argv.includes('exec')).at(-1).argv.find((x) => x.startsWith('permissions.'));
    assert.match(prof, /".git"="write"/);
    for (const p of ['.git/hooks', '.git/config', '.git/info', 'vendor/lib/.git']) assert.ok(prof.includes(`${JSON.stringify(p)}="read"`), p);
    // Linux: missing internals are not listed (bubblewrap would mount a placeholder that breaks git).
    if (process.platform !== 'darwin') assert.ok(!prof.includes('".git/commondir"'), prof);
  } finally {
    await s.close();
  }
});

test('protected revert policy "report": nothing is moved, everything reported; placeholders still removed', async () => {
  const h = H({ git: true });
  fs.writeFileSync(path.join(h.proj, 'AGENTS.md'), 'orijinal\n');
  const s = await startServer(h, 'claude', { CLIVOXA_PROTECTED_POLICY: 'report' });
  try {
    const r = await s.call('ask_claude', { prompt: 'x [[FAKE:plant=AGENTS.md]] [[FAKE:plant=.codex/config.toml]]', workdir: h.proj, access: 'write', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.text, /politika report: .*AGENTS\.md \(reported\)/);
    assert.equal(fs.readFileSync(path.join(h.proj, 'AGENTS.md'), 'utf8'), 'planted\n');
    assert.ok(fs.existsSync(path.join(h.proj, '.codex', 'config.toml')));
  } finally {
    await s.close();
  }
});

test('symlinked CLIVOXA_HOME: the capacity re-check never reaps healthy jobs', async () => {
  const h = H();
  const real = path.join(h.home, 'arsiv-gercek');
  fs.mkdirSync(real);
  const link = path.join(h.home, 'arsiv-link');
  fs.symlinkSync(real, link);
  const s = await startServer(h, 'codex', { CLIVOXA_HOME: link, CLIVOXA_MAX_RUNNING_PER_TARGET: '2' });
  try {
    const a = await s.call('ask_codex', { prompt: 'uzun [[FAKE:sleep=8]]', wait_seconds: 0 });
    const b = await s.call('ask_codex', { prompt: 'uzun [[FAKE:sleep=8]]', wait_seconds: 0 });
    assert.equal(a.h.status, 'running', a.text);
    assert.equal(b.h.status, 'running', b.text);
    // Wait until both runners have claimed their jobs (runner.json), so liveness is really probed.
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && ![a, b].every((x) => fs.existsSync(path.join(real, 'jobs', x.h.job_id, 'runner.json')))) await new Promise((r) => setTimeout(r, 50));
    assert.ok(a.h.job_dir.startsWith(real), `job_dir is canonical: ${a.h.job_dir}`);
    const c = await s.call('ask_codex', { prompt: 'üçüncü', wait_seconds: 0 });
    assert.equal(c.isError, true, c.text);
    assert.match(c.text, /çok fazla iş/);
    for (const x of [a, b]) {
      const g = await s.call('get_job', { job_id: x.h.job_id, wait_seconds: 0 });
      assert.equal(g.h.status, 'running', g.text);
    }
    for (const x of [a, b]) {
      const d = await untilDone(s, x.h.job_id);
      assert.equal(d.h.status, 'done', d.text);
    }
  } finally {
    await s.close();
  }
});

test('codex features list failure: job fails closed and nothing is cached; no-workdir argv always disables the shell', async () => {
  const h = H();
  const s = await startServer(h, 'codex', { FAKE_CODEX_FEATURES: 'fail' });
  try {
    const r = await s.call('ask_codex', { prompt: 'x', wait_seconds: 30 });
    assert.equal(r.h.status, 'error', r.text);
    assert.match(r.text, /features list başarısız/);
    const capsDir = path.join(h.clivoxa, 'caps');
    assert.deepEqual(fs.existsSync(capsDir) ? fs.readdirSync(capsDir).filter((n) => /^codex-[0-9a-f]+\.json$/.test(n)) : [], []);
  } finally {
    await s.close();
  }
  const s2 = await startServer(h, 'codex', { FAKE_CODEX_FEATURES: 'empty' });
  try {
    const r = await s2.call('ask_codex', { prompt: 'x', wait_seconds: 30 });
    assert.equal(r.h.status, 'error', r.text);
    assert.match(r.text, /beklenmeyen çıktı/);
  } finally {
    await s2.close();
  }
  const s3 = await startServer(h, 'codex');
  try {
    const r = await s3.call('ask_codex', { prompt: 'x', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    const e = argvLog(h).filter((x) => x.cli === 'codex' && x.argv.includes('exec')).at(-1).argv.join(' ');
    for (const f of ['shell_tool', 'unified_exec', 'view_image']) assert.ok(e.includes(`--disable ${f}`), f);
  } finally {
    await s3.close();
  }
});
