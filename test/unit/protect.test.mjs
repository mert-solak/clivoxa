import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const D = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)));
const imp = (m) => import(pathToFileURL(path.join(D, m)).href);
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-unit-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));
const { gitLayout, gitReadOnly, gitWatchRels } = await imp('security/git-layout.js');
const { snapshot, finalizeProtect } = await imp('security/protected-files.js');
const { profileToml } = await imp('providers/codex/argv.js');
const { loadConfig } = await imp('config/config.js');
const { looksOurs } = await imp('providers/codex/mcp-isolation.js');

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, 'tp-')));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });

test('gitLayout: nested repos, gitdir pointers (in and outside the workdir), submodule and worktree admin dirs', () => {
  const root = tmp();
  git(root, ['init', '-q']);
  fs.mkdirSync(path.join(root, 'vendor', 'lib'), { recursive: true });
  git(path.join(root, 'vendor', 'lib'), ['init', '-q']);
  // A submodule checkout: `.git` file pointing into the superproject's .git/modules.
  fs.mkdirSync(path.join(root, '.git', 'modules', 'libs', 'sub', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'modules', 'libs', 'sub', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(root, 'libs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'libs', 'sub', '.git'), 'gitdir: ../../.git/modules/libs/sub\n');
  // A pointer to a gitdir elsewhere inside the workdir, and one outside it.
  fs.mkdirSync(path.join(root, '.repos', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.repos', 'x', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', '.git'), 'gitdir: ../.repos/x\n');
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'ext'));
  fs.writeFileSync(path.join(root, 'ext', '.git'), `gitdir: ${outside}\n`);
  fs.mkdirSync(path.join(root, '.git', 'worktrees', 'wt1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep', '.git'), { recursive: true });

  const l = gitLayout(root);
  assert.equal(l.complete, true);
  assert.equal(l.topIsDir, true);
  assert.deepEqual(l.entries, ['.git', 'ext/.git', 'libs/sub/.git', 'pkg/.git', 'vendor/lib/.git']);
  assert.deepEqual(l.pointers, ['ext/.git', 'libs/sub/.git', 'pkg/.git']);
  assert.deepEqual(l.gitDirs, ['.git', '.git/modules/libs/sub', '.git/worktrees/wt1', '.repos/x', 'vendor/lib/.git']);
  const watch = gitWatchRels(l);
  for (const w of ['.git/hooks', '.git/commondir', '.git/modules/libs/sub/hooks', '.git/worktrees/wt1/commondir', '.repos/x/config', 'vendor/lib/.git/config', 'pkg/.git']) assert.ok(watch.includes(w), w);
  // Without git_write the top-level .git is read-only as a whole (profile/settings rule); nested ones always.
  assert.deepEqual(gitReadOnly(root, l, false, 'linux'), ['.repos/x', 'ext/.git', 'libs/sub/.git', 'pkg/.git', 'vendor/lib/.git']);
  const ro = gitReadOnly(root, l, true, 'linux');
  for (const p of ['.git/hooks', '.git/config', '.git/info', '.git/modules', '.git/worktrees', 'vendor/lib/.git', '.repos/x']) assert.ok(ro.includes(p), p);
  assert.ok(!ro.includes('.git/commondir'), 'missing paths are not listed on Linux');
  assert.ok(gitReadOnly(root, l, true, 'darwin').includes('.git/commondir'), 'macOS denies creating them');
  const cfg = loadConfig({ HOME: root, CLIVOXA_HOME: path.join(root, '.t') });
  const toml = profileToml(cfg, { kind: 'rw', gitWrite: true, network: false, allowSlashTmp: false, git: { readOnly: ro, topWritable: true } });
  assert.match(toml, /".git"="write"/);
  assert.match(toml, /"vendor\/lib\/\.git"="read"/);
  const noTop = profileToml(cfg, { kind: 'rw', gitWrite: true, network: false, allowSlashTmp: false, git: { readOnly: [], topWritable: false } });
  assert.match(noTop, /".git"="read"/, 'a .git pointer at the top stays read-only even with git_write');
});

test('finalizeProtect: sandbox placeholders removed silently; host-managed paths and incomplete walks only reported', () => {
  const root = tmp();
  const job = tmp();
  fs.mkdirSync(path.join(root, '.idea'));
  fs.writeFileSync(path.join(root, '.idea', 'workspace.xml'), '<a/>\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'orijinal\n');
  snapshot(root, job, { watch: [], entries: [], complete: true });
  // Linux bubblewrap leftovers: 0-byte 0444 files and empty dirs.
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '');
  fs.chmodSync(path.join(root, 'AGENTS.md'), 0o444);
  fs.mkdirSync(path.join(root, '.codex'));
  // IDE rewrites its state; someone edits CLAUDE.md during the job.
  fs.writeFileSync(path.join(root, '.idea', 'workspace.xml'), '<b/>\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'kullanıcı düzenledi\n');
  const s = finalizeProtect(job, 'revert');
  const by = Object.fromEntries(s.items.map((i) => [i.path, i]));
  assert.equal(by['AGENTS.md'].action, 'placeholder_removed');
  assert.equal(by['.codex'].action, 'placeholder_removed');
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.equal(by['.idea/workspace.xml'].action, 'reported');
  assert.equal(fs.readFileSync(path.join(root, '.idea', 'workspace.xml'), 'utf8'), '<b/>\n');
  assert.equal(by['CLAUDE.md'].action, 'reverted');
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'orijinal\n');
  assert.equal(fs.readFileSync(path.join(job, by['CLAUDE.md'].saved_as), 'utf8'), 'kullanıcı düzenledi\n', 'the replaced version is kept');
  assert.deepEqual(finalizeProtect(job, 'revert'), s, 'idempotent');

  // A snapshot whose .git walk was incomplete never quarantines (a "new" .git may just be unseen).
  const root2 = tmp();
  const job2 = tmp();
  snapshot(root2, job2, { watch: [], entries: [], complete: false });
  fs.mkdirSync(path.join(root2, 'x', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'x', '.git', 'config'), '[core]\n');
  const s2 = finalizeProtect(job2, 'revert');
  assert.deepEqual(s2.items, [{ path: 'x/.git', action: 'reported' }]);
  assert.equal(s2.scan_complete, false);
  assert.ok(fs.existsSync(path.join(root2, 'x', '.git', 'config')));
});

test('finalizeProtect never acts through a parent the job swapped for a link out of the workdir', () => {
  const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const root = tmp();
  const job = tmp();
  const elsewhere = tmp();
  fs.mkdirSync(path.join(root, 'vendor', 'lib', '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vendor', 'lib', '.git', 'config'), '[core]\n');
  // A link that stays inside the workdir keeps its paths protected.
  fs.mkdirSync(path.join(root, 'inner', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inner', '.git', 'config'), 'inner\n');
  link(path.join(root, 'inner'), path.join(root, 'alias'));
  snapshot(root, job, { watch: ['vendor/lib/.git', 'alias/.git'], entries: ['vendor/lib/.git', 'inner/.git'], complete: true });

  // During the job: the ordinary parent directory becomes a link to another repository.
  fs.mkdirSync(path.join(elsewhere, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, '.git', 'config'), 'elsewhere\n');
  fs.writeFileSync(path.join(elsewhere, '.git', 'hooks', 'pre-commit'), 'theirs\n');
  fs.renameSync(path.join(root, 'vendor', 'lib'), path.join(root, 'vendor', 'moved'));
  link(elsewhere, path.join(root, 'vendor', 'lib'));
  fs.writeFileSync(path.join(root, 'inner', '.git', 'config'), 'changed\n');

  const s = finalizeProtect(job, 'revert');
  const by = Object.fromEntries(s.items.map((i) => [i.path, i]));
  assert.equal(fs.readFileSync(path.join(elsewhere, '.git', 'config'), 'utf8'), 'elsewhere\n', 'files beyond the link are untouched');
  assert.equal(fs.readFileSync(path.join(elsewhere, '.git', 'hooks', 'pre-commit'), 'utf8'), 'theirs\n');
  assert.equal(by['vendor/lib/.git/config'].action, 'unrestorable');
  assert.ok(!fs.existsSync(path.join(job, 'protect', 'after', 'vendor', 'lib', '.git', 'hooks', 'pre-commit')), 'nothing is moved out of the other repository');
  assert.equal(by['alias/.git/config'].action, 'reverted');
  assert.equal(fs.readFileSync(path.join(root, 'inner', '.git', 'config'), 'utf8'), 'inner\n');
});

test('looksOurs: whole-token name, env or this install path; not words that merely contain it', () => {
  const root = path.resolve(D, '..');
  assert.equal(looksOurs({ name: 'clivoxa' }), true);
  assert.equal(looksOurs({ name: 'kopru' }), true, 'old registrations are still recursion risks');
  for (const name of ['clivoxalu', 'clivoxa-tools', 'koprulu', 'kopru-mcp-extra']) {
    assert.equal(looksOurs({ name, transport: { command: '/opt/homebrew/bin/node', args: [`/Users/${name}/mcp/github/index.js`] } }), false, `${name} is unrelated`);
  }
  assert.equal(looksOurs({ name: 'x', transport: { command: 'node', args: ['/a.js'], env: { CLIVOXA_EXPOSE: 'codex' } } }), true);
  assert.equal(looksOurs({ name: 'old', transport: { command: 'node', args: ['/a.js'], env: { KOPRU_EXPOSE: 'codex' } } }), true);
  for (const key of ['CLIVOXA_EXPOSE', 'KOPRU_EXPOSE']) {
    assert.equal(looksOurs({ name: 'via-env', transport: { command: 'env', args: [`${key}=codex`, 'node', '/a.js'] } }), true);
  }
  assert.equal(looksOurs({ name: 'foo', transport: { command: 'node', args: [path.join(root, 'dist', 'index.js')] } }), true, 'a copy of this install under another name');
  for (const arg of ['/Users/a/clivoxa/dist/mcp/server.js', '/Users/a/kopru-mcp/dist/mcp/server.js', '@mertsolak/clivoxa', '@mertsolak/clivoxa@0.1.0', '"@mertsolak/clivoxa"', "'@mertsolak/clivoxa@0.1.0'"]) {
    assert.equal(looksOurs({ name: 'y', transport: { command: 'node', args: [arg] } }), true, arg);
  }
  for (const arg of ['@other/clivoxa', '@other/clivoxa@0.1.0', '"@other/clivoxa"', '@mertsolak/clivoxa.tools', '@mertsolak/clivoxa.tools@0.1.0', '@mertsolak/clivoxa-extra']) {
    assert.equal(looksOurs({ name: 'unrelated', transport: { command: 'npx', args: ['-y', arg] } }), false, `${arg} is a different package`);
  }
  for (const args of [['--package=@other/clivoxa', '--', 'clivoxa'], ['--package', '@other/clivoxa', '--', 'clivoxa']]) {
    assert.equal(looksOurs({ name: 'unrelated', transport: { command: 'npx', args } }), false, 'an explicit foreign package owns its clivoxa bin');
  }
  assert.equal(looksOurs({ name: 'own-package', transport: { command: 'npx', args: ['--package=@mertsolak/clivoxa', '--', 'clivoxa'] } }), true);
  for (const arg of ['github:mert-solak/clivoxa', 'github:mert-solak/clivoxa#main', 'mert-solak/clivoxa']) {
    assert.equal(looksOurs({ name: 'from-github', transport: { command: 'npx', args: ['-y', arg] } }), true, arg);
    assert.equal(looksOurs({ name: 'from-github', transport: { command: 'npx', args: [`--package=${arg}`, '--', 'clivoxa'] } }), true, arg);
  }
  assert.equal(looksOurs({ name: 'own-path', transport: { command: 'npx', args: ['--package=@other/clivoxa', '--', '/apps/clivoxa/dist/mcp/server.js'] } }), true);
});
