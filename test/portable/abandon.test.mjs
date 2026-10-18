import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {abandonJob, computeStatus} from '../../dist/jobs/status.js';
import {msg} from '../../dist/shared/messages.js';

// A job whose runner is gone is finalized by the reaper (best effort) or by cancel_job (restore required).
function fixture(t, {restorable}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-abandon-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const lay = layout(cfg);
  const jobId = '20261017-120000-codex-0123abcd';
  const dir = path.join(lay.jobs, jobId);
  const workdir = path.join(home, 'project');
  fs.mkdirSync(path.join(dir, 'protect'), {recursive: true});
  fs.mkdirSync(lay.locks, {recursive: true});
  fs.mkdirSync(workdir);
  const req = {schema: 1, job_id: jobId, target: 'codex', created_at: new Date().toISOString(), created_at_ms: Date.now(), access: 'write', workdir};
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(req));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({schema: 1, job_id: jobId, target: 'codex', status: 'running', phase: 'running', warnings: []}));
  // A manifest whose entries cannot be read makes the restore throw.
  const manifest = {snapshotted_at_ms: 0, root: workdir, entries: restorable ? [] : null, watch: [], existing_git: [], git_complete: true, truncated: false, finalized: false};
  fs.writeFileSync(path.join(dir, 'protect', 'manifest.json'), JSON.stringify(manifest));
  for (const kind of ['workdir', 'session']) fs.writeFileSync(path.join(lay.locks, `${kind}-${jobId}.json`), JSON.stringify({job_id: jobId, kind}));
  const locks = () => fs.readdirSync(lay.locks).filter((name) => name.includes(jobId)).length;
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  return {cfg, lay, dir, req, locks, meta, finished: () => fs.existsSync(path.join(dir, 'exit_code'))};
}
const cancel = {kind: 'cancelled', message: 'iptal', by: 'cancel', exitCode: 130, protection: 'required'};
const reap = {kind: 'orphaned', message: 'öksüz', by: 'reaper', exitCode: 1, protection: 'best-effort'};

test('cancel_job keeps a job unfinished and locked when its protected files cannot be restored', t => {
  const f = fixture(t, {restorable: false});
  assert.throws(() => abandonJob(f.cfg, f.lay, f.dir, f.req, cancel));
  assert.equal(f.finished(), false, 'a later write job must not start on unrestored files');
  assert.equal(f.locks(), 2);
});

test('the reaper finalizes anyway, warns and releases the locks', t => {
  const f = fixture(t, {restorable: false});
  assert.equal(abandonJob(f.cfg, f.lay, f.dir, f.req, reap), 'finalized');
  assert.equal(f.finished(), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'exit_code'), 'utf8').trim(), '1');
  assert.deepEqual(f.meta().warnings, [msg('protect_restore_failed')]);
  assert.equal(f.locks(), 0);
});

test('a restorable cancel is finalized with its summary; a second finalizer only releases the locks', t => {
  const f = fixture(t, {restorable: true});
  assert.equal(abandonJob(f.cfg, f.lay, f.dir, f.req, cancel), 'finalized');
  const result = JSON.parse(fs.readFileSync(path.join(f.dir, 'result.json'), 'utf8'));
  assert.equal(result.error_kind, 'cancelled');
  assert.equal(fs.readFileSync(path.join(f.dir, 'exit_code'), 'utf8').trim(), '130');
  assert.deepEqual(f.meta().protected.items, []);
  assert.equal(f.locks(), 0);

  for (const kind of ['workdir', 'session']) fs.writeFileSync(path.join(f.lay.locks, `${kind}-${f.req.job_id}.json`), '{}');
  assert.equal(abandonJob(f.cfg, f.lay, f.dir, f.req, reap), 'finalized');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'result.json'), 'utf8')).error_kind, 'cancelled', 'the first result stands');
  assert.equal(f.locks(), 0);
});

test('a runner record that exists but cannot be read is never reaped as a runner that did not start', t => {
  const f = fixture(t, {restorable: true});
  const runner = path.join(f.dir, 'runner.json');
  fs.writeFileSync(runner, JSON.stringify({pid: 1, marker: 'x', started_at_ms: 0}));
  fs.writeFileSync(path.join(f.dir, 'request.json'), JSON.stringify({...f.req, created_at_ms: Date.now() - 3600_000}));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === runner) throw Object.assign(new Error('EBUSY: resource busy or locked'), {code: 'EBUSY'});
    return read(p, ...rest);
  });
  const v = computeStatus(f.cfg, f.lay, f.dir, {reap: true});
  assert.equal(v.status, 'running');
  assert.deepEqual(v.warnings, [msg('status_uncertain')]);
  assert.equal(f.finished(), false, 'a live job is not finalized because its record was briefly unreadable');
  assert.equal(f.locks(), 2);
});
