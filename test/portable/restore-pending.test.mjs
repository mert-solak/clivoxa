import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {acquireLocks, releaseLocks, RestorePending, settleRestores} from '../../dist/jobs/locks.js';
import {retryRestore} from '../../dist/jobs/status.js';
import {finalizeProtect} from '../../dist/security/protected-files.js';
import {jobActivity} from '../../dist/mcp/context.js';

// A write job whose protected-file restore was never confirmed keeps every later job off
// its workdir; each new request retries the restore, and a confirmed restore lets work continue.
function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-pending-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const lay = layout(cfg);
  const ctx = {cfg, lay, target: 'codex'};
  const workdir = path.join(home, 'project');
  const other = path.join(home, 'other');
  fs.mkdirSync(workdir, {recursive: true});
  fs.mkdirSync(other, {recursive: true});
  fs.mkdirSync(lay.jobs, {recursive: true});
  const active = jobActivity(ctx);
  const retry = (id) => retryRestore(cfg, lay, id);
  const markers = () => {
    try { return fs.readdirSync(path.join(lay.locks, 'restore-pending')).sort(); } catch { return []; }
  };
  /** A write job that ran on `dir` and finished without confirming its restore. */
  const finishedWriter = (id, dir) => {
    const job = path.join(lay.jobs, id);
    fs.mkdirSync(path.join(job, 'protect'), {recursive: true});
    fs.writeFileSync(path.join(job, 'request.json'), JSON.stringify({schema: 1, job_id: id, target: 'codex', created_at: new Date().toISOString(), created_at_ms: Date.now(), access: 'write', workdir: dir}));
    fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({schema: 1, job_id: id, target: 'codex', status: 'running', phase: 'running', notes: [], warnings: [], attempts: []}));
    acquireLocks(lay.locks, id, {workdir: dir}, active, retry);
    fs.writeFileSync(path.join(job, 'protect', 'manifest.json'), '{ cut short'); // the restore cannot read it
    fs.writeFileSync(path.join(job, 'result.json'), JSON.stringify({status: 'error', error_kind: 'cli_error', by: 'runner', finished_at: new Date().toISOString(), child_code: 1, has_answer: false, partial_answer: false}));
    fs.writeFileSync(path.join(job, 'exit_code'), '1\n');
    releaseLocks(lay.locks, id);
    return job;
  };
  return {cfg, lay, workdir, other, active, retry, markers, finishedWriter};
}

test('an unreadable snapshot is a failed restore, never "nothing to restore"', t => {
  const f = fixture(t);
  const job = f.finishedWriter('20261017-120000-codex-0000000a', f.workdir);
  assert.throws(() => finalizeProtect(job, 'revert'));
  assert.equal(f.retry('20261017-120000-codex-0000000a'), false);
});

test('a later write or read job is refused while the restore stays unconfirmed; a confirmed restore lets it start', t => {
  const f = fixture(t);
  const a = '20261017-120000-codex-0000000a';
  const job = f.finishedWriter(a, f.workdir);
  assert.deepEqual(f.markers(), [`${a}.json`], 'every write job records a pending restore before it runs');

  const b = '20261017-120100-codex-0000000b';
  assert.throws(() => acquireLocks(f.lay.locks, b, {workdir: path.join(f.workdir, 'sub')}, f.active, f.retry), (e) => e instanceof RestorePending && e.jobId === a);
  assert.equal(fs.existsSync(path.join(f.lay.locks, `workdir-${b}.json`)), false, 'the refused job holds no lock');
  assert.throws(() => settleRestores(f.lay.locks, f.workdir, f.active, f.retry), (e) => e instanceof RestorePending && e.jobId === a, 'reads are refused too');

  // Another project is not affected.
  assert.doesNotThrow(() => acquireLocks(f.lay.locks, '20261017-120200-codex-0000000c', {workdir: f.other}, f.active, f.retry));

  // The cause is fixed: the next request retries, confirms the restore and starts.
  fs.writeFileSync(path.join(job, 'protect', 'manifest.json'), JSON.stringify({snapshotted_at_ms: 0, root: f.workdir, entries: [], watch: [], existing_git: [], git_complete: true, truncated: false, finalized: false}));
  assert.doesNotThrow(() => settleRestores(f.lay.locks, f.workdir, f.active, f.retry));
  assert.ok(!f.markers().includes(`${a}.json`), 'the confirmed restore clears its marker');
  assert.doesNotThrow(() => acquireLocks(f.lay.locks, b, {workdir: f.workdir}, f.active, f.retry));
  assert.ok(f.markers().includes(`${b}.json`));
});

test('a snapshot that was started but whose manifest is gone is a failed restore', t => {
  const f = fixture(t);
  const a = '20261017-120000-codex-0000000a';
  fs.rmSync(path.join(f.finishedWriter(a, f.workdir), 'protect', 'manifest.json'));
  assert.equal(f.retry(a), false);
  assert.throws(() => settleRestores(f.lay.locks, f.workdir, f.active, f.retry), RestorePending);
});

test('a read skips only a running writer; a writer in an unknown state keeps the workdir closed', t => {
  const f = fixture(t);
  const a = '20261017-120000-codex-0000000a';
  f.finishedWriter(a, f.workdir);
  assert.doesNotThrow(() => settleRestores(f.lay.locks, f.workdir, () => 'active', f.retry), 'reads beside a running write job are warned about, not refused');
  assert.throws(() => settleRestores(f.lay.locks, f.workdir, () => 'unknown', f.retry), RestorePending);
});

test('a pending restore whose job archive is gone keeps the workdir closed', t => {
  const f = fixture(t);
  const a = '20261017-120000-codex-0000000a';
  fs.rmSync(f.finishedWriter(a, f.workdir), {recursive: true});
  assert.throws(() => acquireLocks(f.lay.locks, '20261017-120100-codex-0000000b', {workdir: f.workdir}, f.active, f.retry), RestorePending);
});
