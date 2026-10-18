import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mkHome, startServer, untilDone, argvLog, cleanupHome} from '../helpers/harness.mjs';
import {loadConfig} from '../../dist/config/config.js';
import {writeClaudeSettings} from '../../dist/providers/claude/argv.js';
import {binFingerprint, sandboxContext} from '../../dist/providers/capabilities.js';
import {claudeRecordPath, readClaudeRecord} from '../../dist/providers/verification.js';
import {jobErrorMessage} from '../../dist/runner/error-messages.js';

// Windows refuses a command line over 32,767 characters. Inline settings JSON with the user's deny rules
// passed it, and the failed spawn was reported as "claude bulunamadı".
test('a Claude job whose deny rules pass the Windows command-line limit starts; settings go through a private file', async (t) => {
  const h = mkHome();
  t.after(() => cleanupHome(h));
  // 200 rules is the cap mergeUserDeny keeps; each is near the 480-character limit it accepts.
  const rules = Array.from({length: 200}, (_, n) => `Read(/${'deep/'.repeat(90)}rule-${n}.txt)`);
  fs.mkdirSync(path.join(h.proj, '.claude'));
  fs.writeFileSync(path.join(h.proj, '.claude', 'settings.json'), JSON.stringify({permissions: {deny: rules}}));
  assert.ok(JSON.stringify(rules).length > 32_767, 'the fixture alone exceeds the Windows limit');
  const server = await startServer(h, 'claude');
  try {
    const first = await server.call('ask_claude', {prompt: 'oku', workdir: h.proj, wait_seconds: 30});
    const r = first.h.status === 'running' ? await untilDone(server, first.h.job_id) : first;
    assert.equal(r.h.status, 'done', r.text);
    const e = argvLog(h).filter((x) => x.cli === 'claude' && x.argv.includes('-p')).at(-1);
    const file = e.argv[e.argv.indexOf('--settings') + 1];
    assert.equal(path.dirname(file), r.h.job_dir, 'in the private job directory');
    assert.notEqual(path.dirname(file), e.env.TMPDIR, 'never in the TMPDIR the child may write');
    for (const rule of rules) assert.ok(e.settings.permissions.deny.includes(rule), 'every user deny rule is kept');
    assert.ok(e.settings.permissions.deny.some((d) => d.includes('/.ssh/**')), 'built-in deny rules are kept');
    assert.equal(e.settings.sandbox.failIfUnavailable, true);
    assert.ok(!fs.existsSync(file), 'removed when the attempt ended');
    assert.ok(e.argv.join(' ').length < 8_000, `argv stays short: ${e.argv.join(' ').length}`);
  } finally {
    await server.close();
  }
});

test('an over-long command line is reported as such, not as a missing CLI', () => {
  const cfg = loadConfig({HOME: os.tmpdir()});
  for (const detail of ['spawn ENAMETOOLONG', 'spawn E2BIG']) {
    const text = jobErrorMessage('claude', 'spawn_failed', detail, cfg);
    assert.doesNotMatch(text, /bulunamadı/, detail);
    assert.match(text, /komut satırı/, detail);
  }
  assert.match(jobErrorMessage('claude', 'spawn_failed', 'spawn ENOENT', cfg), /^claude bulunamadı/);
});

test('a Claude verification made with inline settings is not trusted; jobs re-verify with the settings file', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-claude-record-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const claude = path.join(home, 'claude.exe');
  fs.writeFileSync(claude, 'not a real claude');
  const cfg = loadConfig({HOME: home, USERPROFILE: home, PATH: '', CLAUDE_BIN: claude, CLIVOXA_HOME: path.join(home, '.clivoxa'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex')});
  const fp = binFingerprint(claude);
  const file = claudeRecordPath(cfg, fp);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const record = {fp, context: sandboxContext(cfg), at: Date.now(), read: true, write: true, details: {}};
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(readClaudeRecord(cfg), null, 'a record without settings:"file" predates the settings file');
  fs.writeFileSync(file, JSON.stringify({...record, settings: 'file'}));
  assert.equal(readClaudeRecord(cfg)?.write, true);
});

test('the settings file is created fresh and owner-only; a planted link is replaced, not followed', {skip: process.platform === 'win32' ? 'POSIX modes and unprivileged symlinks' : false}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-settings-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const target = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(target, 'keep');
  const file = path.join(dir, 'claude-settings.attempt1.json');
  fs.symlinkSync(target, file);
  writeClaudeSettings(file, {permissions: {deny: ['Read(//x)']}});
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {permissions: {deny: ['Read(//x)']}});
});
