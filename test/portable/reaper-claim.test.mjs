import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {computeStatus} from '../../dist/jobs/status.js';
import {linkOnce} from '../../dist/system/fs.js';

// A runner that starts late must not run next to a reap that already released its workdir lock:
// two write jobs could then edit one workdir. Both take the job through the same one-shot claim.
test('the reaper claims a job whose runner never started before finalizing it; a late runner finds it taken', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-reaper-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const lay = layout(cfg);
  const jobId = '20261017-120000-codex-0123abcd';
  const dir = path.join(lay.jobs, jobId);
  fs.mkdirSync(dir, {recursive: true});
  fs.mkdirSync(lay.locks, {recursive: true});
  const created = Date.now() - cfg.startupGraceMs - 60_000;
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({schema: 1, job_id: jobId, target: 'codex', created_at: new Date(created).toISOString(), created_at_ms: created, access: 'read', workdir: null}));
  // A meta file that cannot be read may name a live child, so this reap stays pending after its claim.
  fs.writeFileSync(path.join(dir, 'meta.json'), '{not json');
  fs.writeFileSync(path.join(lay.locks, `session-${jobId}.json`), JSON.stringify({job_id: jobId, kind: 'session'}));

  const pending = computeStatus(cfg, lay, dir, {reap: true});
  assert.equal(pending.status, 'running');
  const claim = JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'), 'utf8'));
  assert.deepEqual([claim.pid, claim.marker], [0, 'clivoxa-reaped'], 'the reaper holds the claim before it changes anything');
  assert.equal(linkOnce(path.join(dir, 'runner.json'), JSON.stringify({pid: process.pid, marker: `--clivoxa-job ${jobId}`}) + '\n'), false, 'a late runner cannot claim the job');

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({schema: 1, job_id: jobId, target: 'codex', status: 'running', phase: 'starting', warnings: []}));
  const done = computeStatus(cfg, lay, dir, {reap: true});
  assert.equal(done.status, 'error');
  assert.equal(done.result.error_kind, 'runner_start_failed', 'its own claim does not turn it into an orphaned runner');
  assert.equal(fs.readdirSync(lay.locks).filter((name) => name.includes(jobId)).length, 0);
});
