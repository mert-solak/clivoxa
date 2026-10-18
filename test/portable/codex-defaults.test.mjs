import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexDefaults} from '../../dist/providers/codex/defaults.js';

// Codex does not report the model it used; without an explicit one it is the configured default.
test('the Codex default model and effort come from the top-level keys of config.toml only', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-codex-defaults-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  assert.deepEqual(codexDefaults(home), {}, 'no config, nothing known');
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "gpt-6.1-sol"  # default',
    'model_reasoning_effort = "low"',
    '',
    '[profiles.fast]',
    'model = "other-model"',
    '[mcp_servers.x]',
    'bearer_token = "secret"',
  ].join('\r\n'));
  assert.deepEqual(codexDefaults(home), {model: 'gpt-6.1-sol', effort: 'low'});
  fs.writeFileSync(path.join(home, 'config.toml'), '[profiles.fast]\nmodel = "only-in-a-profile"\n');
  assert.deepEqual(codexDefaults(home), {}, 'a profile model is not the default');
  fs.writeFileSync(path.join(home, 'config.toml'), 'profile = "fast"\nmodel = "gpt-6.1-sol"\n\n[profiles.fast]\nmodel = "other-model"\n');
  assert.deepEqual(codexDefaults(home), {}, 'a selected profile decides the model; it is not guessed');
  fs.writeFileSync(path.join(home, 'config.toml'), 'notify = [\n  "a",\n]\nmodel = "gpt-6.1-sol"\n[mcp_servers.x]\n');
  assert.deepEqual(codexDefaults(home), {model: 'gpt-6.1-sol'}, 'a multi-line array value does not end the top level');
  fs.writeFileSync(path.join(home, 'config.toml'), '[projects."/h/p"]\ntrust_level = "trusted"\n[profiles."x y"]\nmodel = "in-a-table"\n');
  assert.deepEqual(codexDefaults(home), {}, 'keys under a quoted table header are not top-level');
  fs.writeFileSync(path.join(home, 'config.toml'), "profile = 'fast'\nmodel = \"gpt-6.1-sol\"\n");
  assert.deepEqual(codexDefaults(home), {}, 'a literal-string profile also counts as selected');
});
