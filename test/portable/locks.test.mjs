import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withMutex} from '../../dist/jobs/locks.js';

// The lock mutex is a directory with an owner record. Other processes are simulated by changing it
// from inside a critical section (a steal while this one runs) or between withMutex's look and act.
function locksDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-locks-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const mutex = (locks) => path.join(locks, '.mutex');
const ownerToken = (locks) => {
  try { return JSON.parse(fs.readFileSync(path.join(mutex(locks), 'owner.json'), 'utf8')).token; } catch { return null; }
};
// Another live process now holds the mutex path.
function takeOver(locks, token) {
  fs.rmSync(mutex(locks), {recursive: true, force: true});
  fs.mkdirSync(mutex(locks));
  fs.writeFileSync(path.join(mutex(locks), 'owner.json'), JSON.stringify({pid: process.pid, at: Date.now(), token}));
}
function age(locks, ms) {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(mutex(locks), then, then);
}

test('a released mutex leaves nothing behind', t => {
  const locks = locksDir(t);
  assert.equal(withMutex(locks, () => 42), 42);
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('old mutexes are still stolen: ownerless after 10 s, any owner after 60 s', t => {
  const locks = locksDir(t);
  fs.mkdirSync(mutex(locks));
  age(locks, 15_000);
  assert.equal(withMutex(locks, () => 'ownerless'), 'ownerless');
  takeOver(locks, 'stuck');
  age(locks, 120_000);
  assert.equal(withMutex(locks, () => 'stuck'), 'stuck');
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('a holder whose mutex was stolen leaves the thief\'s mutex in place', t => {
  const locks = locksDir(t);
  withMutex(locks, () => takeOver(locks, 'thief'));
  assert.equal(ownerToken(locks), 'thief', 'deleting it would let a third process in while the thief is inside');
});

test('a holder whose mutex was stolen never moves the thief\'s record aside', t => {
  const locks = locksDir(t);
  const record = path.join(mutex(locks), 'owner.json');
  let moved = 0;
  withMutex(locks, () => {
    takeOver(locks, 'thief');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, ...rest) => {
      if (from === record) moved++;
      return rename(from, ...rest);
    });
  });
  assert.equal(moved, 0, 'the thief releasing meanwhile would find no record and leave its mutex behind');
  assert.equal(ownerToken(locks), 'thief');
});

for (const kind of ['ownerless', 'stuck']) {
  test(`a steal spares the fresh mutex that replaced a stale ${kind} one after the staleness check`, t => {
    const locks = locksDir(t);
    if (kind === 'ownerless') fs.mkdirSync(mutex(locks));
    else takeOver(locks, 'stuck');
    age(locks, 120_000);
    let checks = 0;
    let survived = null;
    // withMutex reads the mutex age with fs.statSync: another waiter acts right after each look.
    const stat = fs.statSync;
    t.mock.method(fs, 'statSync', (p, ...rest) => {
      const st = stat(p, ...rest);
      if (p !== mutex(locks)) return st;
      checks++;
      if (checks === 1) takeOver(locks, 'fresh'); // it steals the stale mutex first and enters
      if (checks === 2) {
        survived = ownerToken(locks);
        fs.rmSync(mutex(locks), {recursive: true, force: true}); // ...and leaves
      }
      return st;
    });
    assert.equal(withMutex(locks, () => 'entered'), 'entered');
    assert.equal(survived, 'fresh', 'deleting it would put two processes inside');
    assert.deepEqual(fs.readdirSync(locks), []);
  });
}
