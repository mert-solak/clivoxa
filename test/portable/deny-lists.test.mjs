import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {clivoxaPrivatePaths} from '../../dist/security/workspace.js';
import {buildClaudeSettings, claudeReadDeny} from '../../dist/providers/claude/argv.js';
import {codexReadDeny} from '../../dist/providers/codex/argv.js';

// Both sub-agents get their read-deny list for Clivoxa's own state from one place.
test('both sub-agents are denied Clivoxa private state in every state dir, including a custom CLIVOXA_HOME', t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-deny-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const custom = path.join(home, 'state');
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: custom});
  const own = clivoxaPrivatePaths(cfg);
  for (const root of [path.join(home, '.clivoxa'), custom]) {
    assert.ok(own.files.includes(path.join(root, 'install.json')), root);
    for (const rel of ['jobs', 'sessions', 'locks', 'caps']) assert.ok(own.dirs.includes(path.join(root, rel)), `${root} ${rel}`);
  }
  assert.ok(!own.dirs.some((d) => /[\\/](scratch|tmp)$/.test(d)), "scratch and tmp stay readable: they are the child's cwd and TMPDIR");

  assert.ok(own.dirs.includes(path.join(custom, 'backups')), 'setup keeps configuration backups (which hold secrets) here');
  const sandbox = buildClaudeSettings(cfg, {access: 'read', shell: true, cwd: path.join(home, 'project'), tmpDir: path.join(custom, 'tmp'), userDeny: [], web: 'off', network: false, gitWrite: false, gitDirs: [], agent: false, mode: 'new', sessionId: 's', model: 'm', effort: 'low', jobId: 'j'});
  assert.ok(JSON.stringify(sandbox).includes(JSON.stringify(path.join(custom, 'backups')).slice(1, -1)), "the Claude shell sandbox denies it too, not only the Read tool");

  const codex = codexReadDeny(cfg);
  for (const p of [...own.dirs, ...own.files]) assert.ok(codex.some((d) => p === d || p.startsWith(d + path.sep)), p);
  const claude = claudeReadDeny(cfg).join('\n');
  assert.equal(claude.match(/install\.json/g)?.length, own.files.length, 'every install.json is denied to Claude too');
});
