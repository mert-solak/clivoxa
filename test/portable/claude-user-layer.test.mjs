import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {mergeUserDeny} from '../../dist/providers/claude/argv.js';
import {collectProjectNotes} from '../../dist/jobs/prompt.js';

// --restricted skips every settings and CLAUDE.md layer, so clivoxa re-supplies them; the child's user layer is CLAUDE_CONFIG_DIR.
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-claude-user-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'Claude Profile');
  const workdir = path.join(root, 'project');
  for (const dir of [path.join(home, '.claude'), profile, path.join(workdir, '.claude')]) fs.mkdirSync(dir, {recursive: true});
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa'), CLAUDE_CONFIG_DIR: profile});
  return {home, profile, workdir, cfg};
}
const settings = (permissions) => JSON.stringify({permissions});

test('a relocated Claude profile keeps its deny rules and CLAUDE.md for the restricted child', (t) => {
  const {home, profile, workdir, cfg} = fixture(t);
  fs.writeFileSync(path.join(profile, 'settings.json'), settings({deny: ['Read(//c/secret/**)']}));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings({deny: ['Bash(curl:*)']}));
  fs.writeFileSync(path.join(profile, 'CLAUDE.md'), 'relocated profile notes');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'inactive default notes');
  assert.deepEqual(mergeUserDeny(cfg, workdir), {rules: ['Bash(curl:*)', 'Read(//c/secret/**)'], warnings: []},
    'the active profile applies, and a rule from the default profile is never dropped');
  assert.deepEqual(collectProjectNotes(cfg, 'claude', null, null).notes.map((note) => note.text), ['relocated profile notes']);
});

test('a relocated copy of the default profile never pushes project deny rules past the rule cap', (t) => {
  const {home, profile, workdir, cfg} = fixture(t);
  const copied = settings({deny: Array.from({length: 120}, (_, i) => `Bash(tool${i}:*)`)});
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), copied);
  fs.writeFileSync(path.join(profile, 'settings.json'), copied);
  fs.writeFileSync(path.join(workdir, '.claude', 'settings.json'), settings({deny: ['Read(//c/project-secret/**)']}));
  const {rules} = mergeUserDeny(cfg, workdir);
  assert.equal(rules.length, 121);
  assert.ok(rules.includes('Read(//c/project-secret/**)'), 'a repeated rule must not use up the cap');
});

test('an untrusted workdir cannot push the user\'s own deny rules past the rule cap', (t) => {
  const {profile, workdir, cfg} = fixture(t);
  fs.writeFileSync(path.join(profile, 'settings.json'), settings({deny: ['Bash(git push:*)']}));
  fs.writeFileSync(path.join(workdir, '.claude', 'settings.json'), settings({deny: Array.from({length: 200}, (_, i) => `Read(//nothing${i})`)}));
  const {rules, warnings} = mergeUserDeny(cfg, workdir);
  assert.equal(rules[0], 'Bash(git push:*)', 'user layers are read before project files');
  assert.equal(rules.length, 200);
  assert.equal(warnings.length, 1, 'a rule the cap drops is reported');
});

test('a project settings file saved with a UTF-8 BOM still contributes its deny rules', (t) => {
  const {workdir, cfg} = fixture(t);
  fs.writeFileSync(path.join(workdir, '.claude', 'settings.json'), String.fromCharCode(0xfeff) + settings({deny: ['Bash(curl:*)'], ask: ['WebFetch']}));
  assert.deepEqual(mergeUserDeny(cfg, workdir), {rules: ['Bash(curl:*)', 'WebFetch'], warnings: []});
});
