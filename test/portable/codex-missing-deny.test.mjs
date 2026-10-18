import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {codexReadDeny, profileToml} from '../../dist/providers/codex/argv.js';

// Codex's Windows sandbox created an empty folder for every missing deny path: ~/.npmrc, ~/.netrc and
// ~/.git-credentials became directories and broke npm and git. Only existing paths go into a profile.
test('a Codex profile denies existing secrets and leaves missing ones out', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-missing-deny-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, PATH: ''});
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const npmrc = path.join(home, '.npmrc');
  const netrc = path.join(home, '.netrc');
  assert.ok(codexReadDeny(cfg).includes(netrc), 'the policy still names it');
  for (const kind of ['ro', 'rw']) {
    const toml = profileToml(cfg, {kind, gitWrite: false, network: false, allowSlashTmp: false});
    assert.ok(toml.includes(`${JSON.stringify(npmrc)}="deny"`), `${kind}: an existing secret is denied`);
    assert.ok(!toml.includes(JSON.stringify(netrc)), `${kind}: a missing one is left out`);
  }
  assert.equal(fs.existsSync(netrc), false, 'building a profile creates nothing');
});
