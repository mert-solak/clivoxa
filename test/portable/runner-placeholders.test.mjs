import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, layout} from '../../dist/config/config.js';
import {Runner} from '../../dist/runner/runner.js';

// Placeholder cleanup removes only empty metadata dirs a sandbox created during the job. A job that
// fails before the top-level state is captured has run nothing sandboxed, so it removes nothing.
const USER_DIRS = ['.git', '.claude', '.codex', '.vscode', '.idea', '.husky'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const target of ['claude', 'codex']) {
  test(`an early ${target} failure keeps the user's empty metadata dirs`, async t => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-placeholders-')));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    // Runner.run() installs signal handlers; remove them again so this test process keeps the defaults.
    const before = new Map(SIGNALS.map((s) => [s, process.listeners(s)]));
    t.after(() => { for (const s of SIGNALS) for (const l of process.listeners(s)) if (!before.get(s).includes(l)) process.off(s, l); });
    const missing = path.join(home, 'missing-cli.exe');
    const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa'), CLAUDE_BIN: missing, CODEX_BIN: missing});
    const lay = layout(cfg);
    const jobId = `20261017-120000-${target}-0123abcd`;
    const dir = path.join(lay.jobs, jobId);
    const workdir = path.join(home, 'project');
    fs.mkdirSync(dir, {recursive: true});
    fs.mkdirSync(lay.locks, {recursive: true});
    for (const name of USER_DIRS) fs.mkdirSync(path.join(workdir, name), {recursive: true});
    const req = {schema: 1, job_id: jobId, target, created_at: new Date().toISOString(), created_at_ms: Date.now(), access: 'read', workdir, cwd: workdir,
      git_dirs: [], shell: false, web: 'off', network: false, git_write: false, effort: 'low', model: 'm', session_id_requested: null, new_session_id: null};
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(req));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({schema: 1, job_id: jobId, target, status: 'running', phase: 'starting', warnings: [], notes: [], attempts: []}));
    await new Runner(cfg, lay, dir, req).run();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).error_kind, 'bin_missing');
    assert.deepEqual(fs.readdirSync(workdir).sort(), [...USER_DIRS].sort());
  });
}
