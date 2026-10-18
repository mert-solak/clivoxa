import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {cliVersion, unsupportedFloor} from '../../dist/setup/verify-host.js';

// The runner refuses a CLI below the floor (cli_too_old); setup must not register one that can only fail.
test('setup recognises a counterpart CLI below the supported floor', () => {
  assert.equal(unsupportedFloor('codex', '0.161.9'), '0.162.1');
  assert.equal(unsupportedFloor('codex', '0.162.1'), null);
  assert.equal(unsupportedFloor('codex', '1.0.0'), null);
  assert.equal(unsupportedFloor('claude', '2.1.299'), '2.1.300');
  assert.equal(unsupportedFloor('claude', '2.2.0'), null);
  assert.equal(unsupportedFloor('codex', null), null, 'an unreadable version is reported elsewhere, not judged here');
});

test('the CLI version is read from --version output', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-floor-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bin = path.join(dir, 'codex.mjs');
  fs.writeFileSync(bin, "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('codex-cli 0.150.0'); process.exit(0); }\nprocess.exit(2);\n", {mode: 0o755});
  const cfg = loadConfig({HOME: dir, USERPROFILE: dir, PATH: '', CODEX_BIN: bin, NODE_BIN: process.execPath});
  assert.equal(cliVersion(cfg, 'codex', {PATH: ''}), '0.150.0');
  assert.equal(unsupportedFloor('codex', cliVersion(cfg, 'codex', {PATH: ''})), '0.162.1');
  assert.equal(cliVersion(cfg, 'claude', {}), null, 'no CLI, no version');
});
