import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findGitEntries, gitLayout, gitReadOnly, gitWatchRels, looksLikeGitDir} from '../../dist/security/git-layout.js';
import {snapshot, finalizeProtect} from '../../dist/security/protected-files.js';

// git accepts a repository whatever its name: HEAD plus objects and refs (of any type on Windows), or HEAD plus a
// commondir that moves them elsewhere. A write job can make one with plain writes; each is protected like `.git`.
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-gitlayout-')));
after(() => fs.rmSync(BASE, {recursive: true, force: true}));
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, 'tp-')));
const put = (abs, text = '') => {
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, text);
};
const bare = abs => {
  put(path.join(abs, 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(abs, 'config'), '[core]\n');
  for (const d of ['objects', 'refs', 'hooks']) fs.mkdirSync(path.join(abs, d), {recursive: true});
};
const job = (root, plant) => {
  const dir = tmp();
  const l = gitLayout(root);
  snapshot(root, dir, {watch: gitWatchRels(l), entries: l.entries, complete: l.complete});
  plant();
  return Object.fromEntries(finalizeProtect(dir, 'revert').items.map(i => [i.path, i.action]));
};

test('every shape git accepts as a repository is found under any name; HEAD alone is not', () => {
  const root = tmp();
  bare(path.join(root, 'dirs'));
  put(path.join(root, 'files', 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(root, 'files', 'objects'));
  put(path.join(root, 'files', 'refs'));
  put(path.join(root, 'wt', 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(root, 'wt', 'commondir'), '../dirs\n');
  bare(path.join(root, 'node_modules'));
  put(path.join(root, 'notrepo', 'HEAD'), 'x\n');
  assert.deepEqual(findGitEntries(root).rels, ['dirs', 'files', 'node_modules', 'wt']);
});

test('a dangling HEAD symlink git accepts is found', t => {
  const root = tmp();
  for (const d of ['objects', 'refs']) fs.mkdirSync(path.join(root, 'r', d), {recursive: true});
  try {
    fs.symlinkSync('refs/heads/main', path.join(root, 'r', 'HEAD'));
  } catch {
    t.skip('creating a file symlink needs a privilege here');
    return;
  }
  assert.deepEqual(findGitEntries(root).rels, ['r']);
});

test('a pre-existing bare repo is read-only even with git_write, watched, and left alone afterwards', () => {
  const root = tmp();
  bare(path.join(root, 'mirror.git'));
  const l = gitLayout(root);
  assert.deepEqual(l.gitDirs, ['mirror.git']);
  assert.ok(gitReadOnly(root, l, true, 'linux').includes('mirror.git'));
  for (const w of ['mirror.git/config', 'mirror.git/hooks']) assert.ok(gitWatchRels(l).includes(w), w);
  assert.deepEqual(job(root, () => {}), {});
  assert.ok(looksLikeGitDir(path.join(root, 'mirror.git')));
});

test('a repository planted under another name loses its HEAD; the user files around it stay', () => {
  const root = tmp();
  put(path.join(root, 'src', 'main.js'), 'user\n');
  const by = job(root, () => {
    bare(path.join(root, 'sub', 'repo'));
    bare(path.join(root, 'src'));
    bare(path.join(root, 'src', 'x', '.git'));
  });
  assert.equal(by['sub/repo/HEAD'], 'quarantined');
  assert.equal(by['src/HEAD'], 'quarantined');
  assert.equal(by['src/x/.git'], 'quarantined', 'a .git inside it is still found');
  assert.ok(!looksLikeGitDir(path.join(root, 'sub', 'repo')));
  assert.ok(!looksLikeGitDir(path.join(root, 'src')));
  assert.equal(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'), 'user\n');
});

test('the workdir itself made a repository loses its HEAD', () => {
  const root = tmp();
  const by = job(root, () => bare(root));
  assert.equal(by.HEAD, 'quarantined');
  assert.ok(!looksLikeGitDir(root));
});
