import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sanitizedCodexConfig} from '../../scripts/lib/codex-config-copy.mjs';
import {sweepStaleVerifications} from '../../scripts/lib/verify-sandbox.mjs';
import {redact} from '../../dist/shared/redact.js';
import {loadConfig} from '../../dist/config/config.js';
import {withRealPaths} from '../../dist/security/workspace.js';
import {SECRET_FILES_REL, SECRET_DIRS_REL} from '../../dist/security/policy.js';
import {gitSafe} from '../../dist/jobs/changes.js';
import {discoverExecutable} from '../../dist/system/executables.js';

const tmp = (t, prefix) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

// The verifier's copy of config.toml sits where a sub-agent may read it: nothing credential-shaped goes in.
test('the verifier copy of config.toml keeps settings and drops anything that may hold a credential', () => {
  const config = [
    'model = "m"', 'forced_login_method = "chatgpt"', 'experimental_bearer_token = "sk-abc"',
    '[mcp_servers.gh]', 'command = "npx"', 'args = [', '  "gh"', ']',
    '[mcp_servers.gh.env]', 'GITHUB_TOKEN = "ghp_x"',
    '[model_providers.corp]', 'name = "corp"', 'http_headers = { Authorization = "Bearer y" }',
    '[model_providers.corp.env_http_headers]', 'X-Key = "CORP"',
    '[profiles.p]', 'api_key = """', 'multi', '"""', 'approval_policy = "never"', 'mcp_servers = { a = { command = "x" } }',
    '["mcp_servers".q]', 'command = "z"',
    '[sandbox_workspace_write]', 'network_access = false',
  ].join('\r\n');
  const out = sanitizedCodexConfig(config);
  assert.doesNotMatch(out, /sk-abc|ghp_x|Bearer y|CORP"|multi|command =|forced_login_method/);
  for (const kept of ['model = "m"', '[model_providers.corp]', 'name = "corp"', 'approval_policy = "never"', '[sandbox_workspace_write]', 'network_access = false']) assert.ok(out.includes(kept), kept);
});

test('staging from a verification killed before its cleanup is swept; fresh or unrelated entries stay', (t) => {
  const dir = tmp(t, 'clivoxa-sweep-');
  const old = path.join(dir, 'verify-0123abcd');
  const fresh = path.join(dir, 'verify-89abcdef');
  const other = path.join(dir, 'keep-me');
  for (const d of [old, fresh, other]) fs.mkdirSync(d);
  const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
  fs.utimesSync(old, hourAgo, hourAgo);
  fs.utimesSync(other, hourAgo, hourAgo);
  sweepStaleVerifications(dir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
});

test('answers mask bearer tokens, URL passwords and PEM blocks; JSON-style credentials are caught', () => {
  assert.equal(redact('x -----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY----- y', 'high').text, 'x [GİZLİ:private_key] y');
  assert.match(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'high').text, /Bearer \[GİZLİ:bearer_token\]$/);
  assert.equal(redact('http://bob:hunter2pw@proxy:8080/', 'high').text, 'http://bob:[GİZLİ:url_password]@proxy:8080/');
  const json = redact('{"password": "s3cr3tvalue", "secret_key":"abcdefgh", "token": "zzzzzzzz"}', 'all').text;
  assert.doesNotMatch(json, /s3cr3tvalue|abcdefgh|zzzzzzzz/);
  assert.equal(redact('-----BEGIN PRIVATE KEY----- without an end', 'high').text, '-----BEGIN PRIVATE KEY----- without an end');
});

// Untrusted output reaches redact() on every get_job: crafted input must not stall the server.
test('redaction stays fast on input crafted against its patterns', () => {
  for (const s of ['-eyJabcdefgh'.repeat(80000), '-----BEGIN PRIVATE KEY-----\n'.repeat(60000), 'Bearer ' + 'a'.repeat(900000)]) {
    const started = Date.now();
    redact(s, 'high');
    assert.ok(Date.now() - started < 3000, `${s.slice(0, 20)}… took ${Date.now() - started} ms`);
  }
});

test('a ceiling Clivoxa does not recognise is the restrictive choice, never the weaker default', () => {
  const at = (env) => loadConfig({HOME: os.tmpdir(), CLIVOXA_HOST: 'claude-code', ...env});
  assert.equal(at({}).maxAccess, 'write', 'unset keeps the host default');
  assert.equal(at({CLIVOXA_MAX_ACCESS: 'Read'}).maxAccess, 'read');
  assert.equal(at({CLIVOXA_MAX_ACCESS: ' WRITE '}).maxAccess, 'write');
  assert.equal(at({CLIVOXA_MAX_ACCESS: 'reed'}).maxAccess, 'read');
  assert.equal(at({CLIVOXA_CLAUDE_NETWORK: 'Deny'}).claudeNetwork, 'deny');
  assert.equal(at({CLIVOXA_CLAUDE_NETWORK: 'denyy'}).claudeNetwork, 'deny');
  assert.equal(at({CLIVOXA_CODEX_NETWORK: 'OPEN'}).codexNetwork, 'open');
});

test('a secret directory reached through a link is denied at its real location too', (t) => {
  const dir = tmp(t, 'clivoxa-real-');
  const target = path.join(dir, 'dotfiles', 'aws');
  fs.mkdirSync(target, {recursive: true});
  const link = path.join(dir, '.aws');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(withRealPaths([link, path.join(dir, 'missing')]), [link, target, path.join(dir, 'missing')]);
  for (const rel of ['.cargo/credentials', '.gem/credentials', '.config/git/credentials', '.pgpass']) assert.ok(SECRET_FILES_REL.includes(rel), rel);
  assert.ok(SECRET_DIRS_REL.includes('.config/rclone'));
});

// `git config --local` ignores include.path: a filter defined through it would run during git status.
test('the git driver check also reads included config files', (t) => {
  const git = discoverExecutable('git', process.env, os.homedir());
  if (!git) return t.skip('git not installed');
  const repo = tmp(t, 'clivoxa-gitsafe-');
  const g = (...a) => spawnSync(git, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {cwd: repo, encoding: 'utf8'});
  g('init', '-q');
  const cfg = loadConfig({HOME: os.tmpdir(), GIT_BIN: git, PATH: process.env.PATH});
  assert.equal(gitSafe(cfg, repo), true);
  fs.writeFileSync(path.join(repo, '.git', 'extra'), '[filter "x"]\n\tclean = echo hi\n');
  g('config', '--local', 'include.path', 'extra');
  assert.equal(gitSafe(cfg, repo), false);
});
