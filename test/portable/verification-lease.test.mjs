import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {sandboxContext} from '../../dist/providers/capabilities.js';
import {ensureCodexVerified} from '../../dist/providers/verification.js';

// Without a codex binary nothing is ever cached, and a verifier that gets the lease fails at once.
function fixture(t, bins = {codex: null}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-lease-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const base = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const cfg = {...base, bins: Object.defineProperties({...base.bins}, Object.getOwnPropertyDescriptors(bins))};
  const caps = layout(cfg).caps;
  fs.mkdirSync(caps, {recursive: true});
  const lock = path.join(caps, `.verify-codex-${sandboxContext(cfg)}.lock`);
  const owner = () => JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  return {cfg, lock, owner};
}
function lease(lock, owner, ageMs) {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, at, at);
}
// The 240 s wait elapses in about 2.4 s.
function fastClock(t) {
  const now = Date.now.bind(Date);
  const start = now();
  t.mock.method(Date, 'now', () => start + (now() - start) * 100);
}

test('a dead verifier\'s lease is reclaimed although its pid now names a live process', async t => {
  const f = fixture(t);
  // This test's own pid stands for a reused one: alive, same user, never "gone".
  lease(f.lock, {pid: process.pid}, 3600_000);
  fastClock(t);
  await assert.rejects(ensureCodexVerified(f.cfg), /CODEX_BIN yok/);
  assert.equal(fs.existsSync(f.lock), false);
});

test('a verifier keeps waiting on a lease its live owner refreshes', async t => {
  const f = fixture(t);
  lease(f.lock, {pid: process.pid, token: 'other'}, 0);
  const touch = setInterval(() => { const at = new Date(Date.now()); fs.utimesSync(f.lock, at, at); }, 100);
  t.after(() => clearInterval(touch));
  fastClock(t);
  await assert.rejects(ensureCodexVerified(f.cfg), /başka bir süreçte tamamlanmadı/);
  assert.equal(f.owner().token, 'other');
});

test('release leaves a lease that another verifier has taken over', async t => {
  let lock = '';
  const f = fixture(t, {get codex() {
    // Once this verifier holds the lease, another one takes it over (as after a stall).
    const file = path.join(lock, 'owner.json');
    if (lock && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token) fs.writeFileSync(file, JSON.stringify({pid: process.pid, token: 'other'}));
    return null;
  }});
  lock = f.lock;
  await assert.rejects(ensureCodexVerified(f.cfg), /CODEX_BIN yok/);
  assert.equal(fs.existsSync(f.lock), true, 'the new owner\'s lease must survive');
  assert.equal(f.owner().token, 'other');
});

test('a verifier refreshes its lease while it verifies', async t => {
  let lock = '';
  let age = null;
  const f = fixture(t, {get codex() {
    // Once this verifier holds the lease, two minutes pass before it finishes.
    if (age === null && lock && fs.existsSync(path.join(lock, 'owner.json'))) {
      t.mock.timers.tick(130_000);
      age = Date.now() - fs.lstatSync(lock).mtimeMs;
    }
    return null;
  }});
  lock = f.lock;
  t.mock.timers.enable({apis: ['setInterval', 'Date'], now: Date.now()});
  await assert.rejects(ensureCodexVerified(f.cfg), /CODEX_BIN yok/);
  assert.ok(age !== null && age < 10_000, `the lease went unrefreshed for ${age} ms`);
  assert.equal(fs.existsSync(f.lock), false);
});
