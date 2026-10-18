import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareRuntime, runtimeBaseDir } from '../../dist/setup/installed-runtime.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function copyPayload(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, {recursive:true});
    for (const name of fs.readdirSync(source)) copyPayload(path.join(source, name), path.join(destination, name));
  } else {
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, fs.readFileSync(source));
  }
}

function fixture(t, realPackage = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-kurulum-İ-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'npx temporary package');
  const userHome = path.join(base, 'User With Spaces');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(userHome);
  if (realPackage) {
    for (const name of ['dist', 'scripts/lib', 'package.json', 'LICENSE']) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      copyPayload(path.join(REPO, name), path.join(source, name));
    }
  } else {
    const files = {
      'package.json': JSON.stringify({ name: '@mertsolak/clivoxa', version: '0.1.0', type: 'module' }),
      'dist/clivoxa.mjs': 'if (process.argv[2] === "--version") console.log("0.1.0"); else process.exit(1);\n',
      'dist/THIRD-PARTY-NOTICES.txt': 'Third-party license fixture\n',
      'scripts/lib/verify-claude.mjs': 'export const fixture = true;\n',
      'scripts/lib/verify-sandbox.mjs': 'export const fixture = true;\n',
      'LICENSE': 'MIT license fixture\n',
    };
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), contents);
    }
  }
  const env = { ...process.env, LOCALAPPDATA: path.join(userHome, 'Local App Data'), XDG_DATA_HOME: path.join(userHome, 'Application Data'), CLIVOXA_HOME: path.join(userHome, '.clivoxa') };
  return { base, source, userHome, env, options: { sourceRoot: source, home: userHome, env } };
}

test('durable runtime survives removal of its npx package and an empty GUI PATH', async t => {
  const fixtureData = fixture(t, true);
  const runtime = await prepareRuntime(fixtureData.options);
  const expected = JSON.parse(fs.readFileSync(path.join(fixtureData.source, 'package.json'), 'utf8')).version;
  assert.equal(fs.realpathSync.native(runtime.command), fs.realpathSync.native(process.execPath));
  assert.ok(path.isAbsolute(runtime.root));
  assert.equal(fs.realpathSync.native(runtime.installRoot), fs.realpathSync.native(runtimeBaseDir(fixtureData.options)));
  assert.deepEqual(runtime.args, [path.join(runtime.root, 'dist', 'clivoxa.mjs')]);
  fs.rmSync(fixtureData.source, { recursive: true });
  const result = spawnSync(runtime.command, [...runtime.args, '--version'], {
    env: { ...fixtureData.env, PATH: '', Path: '', NODE_OPTIONS: '', NODE_PATH: '' },
    cwd: fixtureData.userHome, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
  for (const name of ['scripts/lib/verify-claude.mjs', 'scripts/lib/verify-sandbox.mjs', 'dist/THIRD-PARTY-NOTICES.txt', 'LICENSE']) assert.ok(fs.existsSync(path.join(runtime.root, name)), name);
  const manifest = fs.readFileSync(path.join(runtime.root, '.clivoxa-runtime.json'), 'utf8');
  assert.ok(!manifest.includes(fixtureData.source), 'metadata does not retain the disposable source path');
  assert.ok(!manifest.includes(fixtureData.userHome), 'metadata contains only portable relative payload paths');
});

test('unchanged package reuses verified content; changed or corrupted runtimes retain old copies', async t => {
  const { options, source } = fixture(t);
  const first = await prepareRuntime(options);
  assert.equal((await prepareRuntime(options)).root, first.root);
  fs.appendFileSync(path.join(first.root, 'LICENSE'), 'corruption');
  const repaired = await prepareRuntime(options);
  assert.notEqual(repaired.root, first.root);
  assert.match(fs.readFileSync(path.join(first.root, 'LICENSE'), 'utf8'), /corruption$/);
  assert.equal((await prepareRuntime(options)).root, repaired.root, 'repaired content is itself reusable');
  fs.appendFileSync(path.join(source, 'scripts', 'lib', 'verify-sandbox.mjs'), '// new packaged implementation\n');
  const updated = await prepareRuntime(options);
  assert.notEqual(updated.root, repaired.root);
  assert.ok(fs.existsSync(repaired.args[0]), 'previous jobs retain their runtime');
  assert.ok(fs.existsSync(first.args[0]), 'repair never deletes potentially active old files');
});

test('injected runtime files and forged manifests are never trusted for reuse', async t => {
  const { options } = fixture(t);
  const first = await prepareRuntime(options);
  fs.writeFileSync(path.join(first.root, 'dist', 'unexpected.mjs'), 'throw new Error("injected");');
  const second = await prepareRuntime(options);
  assert.notEqual(second.root, first.root);
  const manifestFile = path.join(second.root, '.clivoxa-runtime.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.package = 'unexpected-package';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const third = await prepareRuntime(options);
  assert.notEqual(third.root, second.root);
});

test('staging version check rejects inconsistent packages and removes only staging', async t => {
  const { options, source } = fixture(t);
  const prior = await prepareRuntime(options);
  fs.writeFileSync(path.join(source, 'dist', 'clivoxa.mjs'), 'console.log("99.0.0");');
  await assert.rejects(prepareRuntime(options), /self-check failed/);
  const children = fs.readdirSync(path.join(prior.installRoot, 'runtime'));
  assert.deepEqual(children, [path.basename(prior.root)]);
  assert.ok(fs.existsSync(prior.args[0]));
});

test('package identity, mandatory notices and directory links are validated before installation', async t => {
  const { options, source, base } = fixture(t);
  const packageFile = path.join(source, 'package.json');
  const original = fs.readFileSync(packageFile);
  fs.writeFileSync(packageFile, JSON.stringify({ name: '@mertsolak/clivoxa', version: '../../escape' }));
  await assert.rejects(prepareRuntime(options), /name or version is invalid/);
  fs.writeFileSync(packageFile, original);
  const notices = path.join(source, 'dist', 'THIRD-PARTY-NOTICES.txt');
  fs.rmSync(notices);
  await assert.rejects(prepareRuntime(options), /missing dist\/THIRD-PARTY-NOTICES/);
  fs.writeFileSync(notices, 'license fixture');
  const outside = path.join(base, 'external scripts');
  fs.renameSync(path.join(source, 'scripts'), outside);
  fs.symlinkSync(outside, path.join(source, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRuntime(options), /real directories, not links/);
  assert.ok(!fs.existsSync(runtimeBaseDir(options)), 'invalid packages create no installation');
});

test('platform application directories are separate from runtime job state', t => {
  const { userHome, env, options } = fixture(t);
  assert.equal(runtimeBaseDir({ ...options, platform: 'win32' }), path.join(env.LOCALAPPDATA, 'clivoxa'));
  assert.equal(runtimeBaseDir({ ...options, platform: 'darwin' }), path.join(userHome, 'Library', 'Application Support', 'clivoxa'));
  assert.equal(runtimeBaseDir({ ...options, platform: 'linux' }), path.join(env.XDG_DATA_HOME, 'clivoxa'));
  assert.equal(runtimeBaseDir({ ...options, platform: 'linux', env: { XDG_DATA_HOME: 'relative' } }), path.join(userHome, '.local', 'share', 'clivoxa'));
  const windowsEnv = { localappdata: env.LOCALAPPDATA };
  assert.equal(runtimeBaseDir({ home: userHome, env: windowsEnv, platform: 'win32' }), path.join(env.LOCALAPPDATA, 'clivoxa'));
  assert.throws(() => runtimeBaseDir({ ...options, platform: 'linux', env: { XDG_DATA_HOME: path.join(userHome, '.clivoxa') } }), /outside Clivoxa/);
  assert.throws(() => runtimeBaseDir({ ...options, platform: 'linux', env: { XDG_DATA_HOME: env.XDG_DATA_HOME, CLIVOXA_HOME: env.XDG_DATA_HOME } }), /outside Clivoxa/);
  assert.throws(() => runtimeBaseDir({ ...options, platform: 'win32', env: { LOCALAPPDATA: 'relative' } }), /absolute path/);
});

test('redirected app-data cannot install a runtime inside job state', async t => {
  const { options, userHome } = fixture(t);
  const state = path.join(userHome, '.clivoxa');
  fs.mkdirSync(state);
  const redirect = path.join(userHome, 'redirected app data');
  fs.symlinkSync(state, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRuntime({ ...options, platform: 'linux', env: { XDG_DATA_HOME: redirect } }), /resolves inside/);
  assert.ok(!fs.existsSync(path.join(state, 'clivoxa', 'runtime')));
});

test('Node is absolute and setup self-check ignores inherited Node code injection flags', async t => {
  const { options } = fixture(t);
  await assert.rejects(prepareRuntime({ ...options, node: 'node' }), /absolute path/);
  const runtime = await prepareRuntime({ ...options, env: { ...options.env, NODE_OPTIONS: '--require=/nonexistent/unsafe-code.js', NODE_PATH: '/nonexistent' } });
  assert.equal(runtime.version, '0.1.0');
});

test('Unix runtime reuse rejects writable payloads and unsafe installation roots', { skip: process.platform === 'win32' ? 'Windows uses profile ACLs instead of Unix modes' : false }, async t => {
  const { options } = fixture(t);
  const first = await prepareRuntime(options);
  fs.chmodSync(first.args[0], 0o666);
  const repaired = await prepareRuntime(options);
  assert.notEqual(repaired.root, first.root);
  assert.equal(fs.statSync(first.args[0]).mode & 0o777, 0o666, 'running old runtime is not modified');
  fs.chmodSync(first.installRoot, 0o777);
  await assert.rejects(prepareRuntime(options), /not writable by others/);
  fs.chmodSync(first.installRoot, 0o700);
});
