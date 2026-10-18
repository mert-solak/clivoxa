import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {collectProjectNotes} from '../../dist/jobs/prompt.js';
import {readNoFollow} from '../../dist/system/fs.js';

// Project notes are copied into the counterpart's prompt, so a note must be the regular file at its own
// path. Windows has no O_NOFOLLOW: open() follows a final-component symlink or junction.
function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-notes-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cfg = loadConfig({HOME: home, USERPROFILE: home, CLIVOXA_HOME: path.join(home, '.clivoxa')});
  const secret = path.join(home, '.netrc');
  fs.writeFileSync(secret, 'machine example.com login me password not-for-the-prompt\n');
  const workdir = path.join(home, 'project');
  fs.mkdirSync(path.join(workdir, '.claude', 'rules'), {recursive: true});
  return {cfg, secret, workdir};
}

test('symlinked CLAUDE.md and rules are not copied into the prompt', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workdir, 'AGENTS.md'), 'real note\n');
  try {fs.symlinkSync(f.secret, path.join(f.workdir, 'CLAUDE.md'), 'file');} catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('file symlinks need Developer Mode or elevation');
    throw error;
  }
  fs.symlinkSync(f.secret, path.join(f.workdir, '.claude', 'rules', 'leak.md'), 'file');
  const {notes} = collectProjectNotes(f.cfg, 'claude', f.workdir, null);
  assert.deepEqual(notes.map((n) => n.rel), ['AGENTS.md']);
});

test('rules are not read through a .claude directory that links elsewhere', t => {
  const f = fixture(t);
  const outside = path.join(path.dirname(f.workdir), 'outside');
  fs.mkdirSync(path.join(outside, 'rules'), {recursive: true});
  fs.writeFileSync(path.join(outside, 'rules', 'x.md'), 'OUTSIDE RULE\n');
  fs.rmSync(path.join(f.workdir, '.claude'), {recursive: true});
  fs.symlinkSync(outside, path.join(f.workdir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(collectProjectNotes(f.cfg, 'claude', f.workdir, null).notes, []);
});

test('readNoFollow refuses a handle that is not the regular file at the path', t => {
  const f = fixture(t);
  const note = path.join(f.workdir, 'CLAUDE.md');
  fs.writeFileSync(note, 'real note\n');
  assert.deepEqual(readNoFollow(note, 1024), {text: 'real note\n', truncated: false});
  // An open() that lands on another file: Windows following a link, or a swap after the check.
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => open(file === note ? f.secret : file, ...rest));
  assert.equal(readNoFollow(note, 1024), null);
});
