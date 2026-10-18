import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {loadConfig} from '../../dist/config/config.js';
import {buildCodexArgv} from '../../dist/providers/codex/argv.js';
import {reviewInstruction} from '../../dist/providers/codex/review.js';
import {decideCodexSandbox} from '../../dist/providers/codex/sandbox-plan.js';
import {reviewRefusal} from '../../dist/mcp/handlers/ask.js';
import {GIT_REF_RE, askShape} from '../../dist/mcp/schemas.js';

const cfg = loadConfig({HOME: os.tmpdir()});
const argvInput = {
  access: 'read', shell: true, web: 'off', cwd: os.tmpdir(), answerFile: 'a.md', model: '', effort: '', jobId: 'j',
  sandbox: {kind: 'legacy'}, mcpOverride: '{}', features: null, allowSlashTmp: false, netOpen: false,
};
const rec = (review) => ({fp: 'x', version: '0', at: Date.now(), context: 'c', details: {}, profiles_verified: {ro: true, rw: false, rw_git: false, rw_net: false, ...(review === undefined ? {} : {review})}});
const read = {access: 'read', workdir: os.tmpdir(), git_write: false, network: false};

// Codex's presets refuse custom instructions, so a review always runs as `exec review -` with the request on stdin.
test('a review runs Codex reviewer with the request on stdin, never as a resumed session', () => {
  const argv = buildCodexArgv({...argvInput, mode: 'new', review: true});
  assert.deepEqual(argv.slice(-2), ['review', '-']);
  assert.equal(buildCodexArgv({...argvInput, mode: 'new'}).at(-1), '-');
  assert.throws(() => buildCodexArgv({...argvInput, mode: 'resume', sessionId: 's', review: true}), /new session/);
});

test('the review request names its target and keeps the caller focus', () => {
  assert.match(reviewInstruction({scope: 'uncommitted', ref: null}, 'cache'), /staged, unstaged, and untracked[\s\S]*cache$/);
  assert.match(reviewInstruction({scope: 'base', ref: 'main'}, 'x'), /git merge-base HEAD main/);
  assert.match(reviewInstruction({scope: 'commit', ref: 'abc123'}, 'x'), /commit abc123/);
});

// The reviewer is another code path inside Codex: it gets files only when the probes passed through it too.
test('a review needs the read profile verified through the reviewer; older records do not count', () => {
  const review = {scope: 'uncommitted', ref: null};
  assert.equal(decideCodexSandbox(cfg, {...read, review}, rec(undefined)).kind, 'codex_profile_unverified');
  assert.equal(decideCodexSandbox(cfg, {...read, review}, rec(false)).kind, 'codex_profile_unverified');
  assert.equal(decideCodexSandbox(cfg, {...read, review}, rec(true)).sandbox?.kind, 'profiles');
  assert.equal(decideCodexSandbox(cfg, read, rec(undefined)).sandbox?.kind, 'profiles', 'a plain read job is unaffected');
});

test('review requests outside its limits are refused with the reason', () => {
  const ok = {access: 'read', workdir: '/w', gitTop: '/w', session: false};
  const t = {scope: 'uncommitted', ref: null};
  assert.equal(reviewRefusal(t, ok), null);
  assert.match(reviewRefusal(t, {...ok, access: 'write'}), /access='read'/);
  assert.match(reviewRefusal(t, {...ok, session: true}), /session_id/);
  assert.match(reviewRefusal(t, {...ok, workdir: null, gitTop: null}), /workdir gerekli/);
  assert.match(reviewRefusal(t, {...ok, gitTop: null}), /git deposu değil/);
  assert.match(reviewRefusal(t, {...ok, shell: false}), /kabuk/);
  assert.match(reviewRefusal({scope: 'uncommitted', ref: 'main'}, ok), /ref yalnız/);
  assert.match(reviewRefusal({scope: 'base', ref: null}, ok), /ref gerekli/);
  assert.equal(reviewRefusal({scope: 'commit', ref: 'abc'}, ok), null);
});

test('only plain git names are accepted as review refs; only ask_codex offers review', () => {
  for (const ok of ['main', 'origin/main', 'v1.2.0', 'abc123', 'HEAD~2', 'feature/x-y']) assert.ok(GIT_REF_RE.test(ok), ok);
  for (const bad of ['-x', '--output=/tmp/x', 'a..b', 'a b', 'a;b', '$(x)', '']) assert.ok(!GIT_REF_RE.test(bad), bad);
  assert.ok('review' in askShape('codex'));
  assert.ok(!('review' in askShape('claude')));
});

test('a finished job tells the user how to open its session in their own CLI', async () => {
  const {ownCliResume} = await import('../../dist/mcp/render.js');
  const sid = '0190f00d-2222-7333-8444-555566667777';
  assert.match(ownCliResume('codex', sid, null), /^codex resume 0190f00d-2222-/);
  assert.match(ownCliResume('claude', sid, '/w'), /^claude --resume 0190f00d-2222-.*\/w/);
  assert.equal(ownCliResume('claude', sid, null), null, 'Claude sessions live per directory; the scratch one is private');
  assert.equal(ownCliResume('codex', 'x; rm -rf ~', null), null, 'only well-formed ids are shown');
  assert.equal(ownCliResume('codex', null, null), null);
});

// Codex review (P2): a revision set such as HEAD^@ would widen a one-commit review silently.
test('a review ref must resolve to one commit; a commit is pinned to its id', {skip: !process.env.PATH && 'no PATH'}, async (t) => {
  const {spawnSync} = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {resolveReviewRef} = await import('../../dist/mcp/handlers/ask.js');
  const {discoverExecutable} = await import('../../dist/system/executables.js');
  const git = (discoverExecutable && discoverExecutable('git', process.env, os.homedir())) || (spawnSync('git', ['--version']).status === 0 ? 'git' : null);
  if (!git) return t.skip('git not installed');
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-ref-')));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const g = (...a) => spawnSync(git, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {cwd: repo, encoding: 'utf8'});
  g('init', '-q', '-b', 'main');
  for (const n of ['1', '2']) { fs.writeFileSync(path.join(repo, 'f'), n); g('add', 'f'); g('commit', '-qm', n); }
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const c = loadConfig({HOME: os.tmpdir(), GIT_BIN: git, PATH: process.env.PATH});
  assert.deepEqual(resolveReviewRef(c, repo, {scope: 'commit', ref: 'HEAD'}), {ref: head});
  assert.deepEqual(resolveReviewRef(c, repo, {scope: 'base', ref: 'main'}), {ref: 'main'}, 'a base keeps its readable name');
  assert.deepEqual(resolveReviewRef(c, repo, {scope: 'uncommitted', ref: null}), {ref: null});
  for (const set of ['HEAD^@', 'HEAD^-', 'HEAD^!', 'nope']) assert.match(resolveReviewRef(c, repo, {scope: 'commit', ref: set}).reason, /tek bir commit/, set);
});
