import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {acquireLocks, LockConflict, RestorePending} from '../../dist/jobs/locks.js';
import {jobActivity} from '../../dist/mcp/context.js';

// A live write job (inside its startup grace, so no runner is needed) holding the workdir lock.
function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-lockact-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const lay = layout(cfg);
  const ctx = {cfg, lay, target: 'codex'};
  const jobId = '20261017-120000-codex-0123abcd';
  const dir = path.join(lay.jobs, jobId);
  const workdir = path.join(home, 'project');
  fs.mkdirSync(dir, {recursive: true});
  fs.mkdirSync(workdir);
  const request = path.join(dir, 'request.json');
  fs.writeFileSync(request, JSON.stringify({schema: 1, job_id: jobId, target: 'codex', created_at: new Date().toISOString(), created_at_ms: Date.now(), access: 'write', workdir}));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({schema: 1, job_id: jobId, target: 'codex', status: 'starting', phase: 'starting', notes: [], warnings: [], attempts: []}));
  acquireLocks(lay.locks, jobId, {workdir}, jobActivity(ctx));
  const lock = path.join(lay.locks, `workdir-${jobId}.json`);
  const second = () => acquireLocks(lay.locks, '20261017-120001-codex-0000000b', {workdir}, jobActivity(ctx));
  return {ctx, jobId, request, lock, second};
}

// What a scanner or backup holding the file with FileShare.None (or EMFILE) looks like to readFileSync.
function busy(t, file) {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === file) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), {code: 'EBUSY'});
    return read(p, ...rest);
  });
}

test('a live job whose request cannot be read keeps its workdir lock', t => {
  const f = fixture(t);
  assert.equal(jobActivity(f.ctx)(f.jobId), 'active');
  busy(t, f.request);
  assert.equal(jobActivity(f.ctx)(f.jobId), 'unknown', 'an unreadable request is not a finished job');
  assert.throws(f.second, e => e instanceof LockConflict && e.kind === 'workdir' && e.jobId === f.jobId);
  assert.equal(fs.existsSync(f.lock), true, 'the live job keeps its lock');
});

test('an unreadable lock of a live job still conflicts', t => {
  const f = fixture(t);
  busy(t, f.lock);
  assert.throws(f.second, e => e instanceof LockConflict && e.kind === 'workdir' && e.jobId === f.jobId);
  assert.equal(fs.existsSync(f.lock), true);
});

test('a job without a request releases its lock, but its unconfirmed restore keeps the workdir closed', t => {
  const f = fixture(t);
  fs.rmSync(f.request);
  assert.equal(jobActivity(f.ctx)(f.jobId), 'finished');
  assert.throws(f.second, e => e instanceof RestorePending && e.jobId === f.jobId, 'it was a write job and never confirmed a restore');
  assert.equal(fs.existsSync(f.lock), false, 'the stale lock is removed');
});
