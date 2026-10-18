import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { discoverHosts, renderHostConfig, readHostLaunch, isHostEnabled, entryFingerprint,
  removeHostEntry } from '../../dist/setup/host-config.js';
import { classifyDesktopProcess, desktopUsesProfile, windowsPackageContainer } from '../../dist/setup/desktop-processes.js';

const host = (id) => ({ id, label: id, file: '/unused/config',
  role: id === 'codex' ? 'claude' : 'codex', host: id === 'claude-desktop' ? 'desktop' : id });
const launch = { command: '/node with spaces/node', args: ['/data/Çalışma/clivoxa.mjs'],
  env: { CLIVOXA_MAX_ACCESS: 'write', NODE_BIN: '/node with spaces/node', CODEX_BIN: '/bin/codex' } };
const options = (overrides = {}) => ({ platform: 'linux', home: '/users/deniz', env: {}, bins: {},
  exists: () => false, directories: () => [], ...overrides });

test('Windows Store Desktop profiles are discovered without guessing publisher IDs or creating profiles', () => {
  const family = 'Claude_pzs8sxrjxfjjc';
  const profile = `D:\\Local\\Packages\\${family}\\LocalCache\\Roaming\\Claude`;
  const existing = new Set([profile]);
  const opts = options({ platform: 'win32', home: 'C:\\Users\\Çağrı',
    env: { localappdata: 'D:\\Local', AppData: 'D:\\Roaming' },
    exists: file => existing.has(file), directories: directory => {
      if (directory === 'D:\\Local\\Claude-Data') return [];
      assert.equal(directory, 'D:\\Local\\Packages');
      return ['Other_1234567890123', 'Claude_1234567890123', '../Claude_pzs8sxrjxfjjc', family];
    } });
  const found = discoverHosts(opts);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, `${profile}\\claude_desktop_config.json`);
  assert.equal(found[0].host, 'desktop');
  assert.match(found[0].label, /MSIX/);
  existing.add('D:\\Roaming\\Claude');
  const both = discoverHosts(opts);
  assert.equal(both.length, 2);
  assert.equal(new Set(both.map(item => item.file)).size, 2);
  assert.ok(both.every(item => item.id === 'claude-desktop'));
  const redirected = discoverHosts({ ...opts, env: { LOCALAPPDATA: 'D:\\Local',
    APPDATA: `D:\\Local\\Packages\\${family}\\LocalCache\\Roaming` } });
  assert.equal(redirected.length, 1, 'an already redirected APPDATA must not register the same file twice');
});

test('Windows discovers the Store package family and Desktop data moved out of the package', () => {
  const store = 'AnthropicPBC.Claude_fnn82j28hfe8t';
  const storeProfile = `D:\\Local\\Packages\\${store}\\LocalCache\\Roaming\\Claude`;
  const movedProfile = 'D:\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc';
  const existing = new Set([storeProfile, movedProfile]);
  const found = discoverHosts(options({ platform: 'win32', home: 'C:\\Users\\deniz', env: { LOCALAPPDATA: 'D:\\Local' },
    exists: file => existing.has(file), directories: directory => directory === 'D:\\Local\\Packages'
      ? [store, 'Contoso.Claude_fnn82j28hfe8t'] : ['claude_pzs8sxrjxfjjc', 'claude_short', 'notes'] }));
  assert.deepEqual(found.map(item => item.file), [
    `${storeProfile}\\claude_desktop_config.json`, `${movedProfile}\\claude_desktop_config.json`]);
  assert.match(found[0].label, /Microsoft Store/);
  assert.match(found[1].label, /paket dışı/);
});

test('running Desktop detection maps processes to the profiles they rewrite, never to Claude Code', () => {
  const env = { local: 'C:\\Users\\deniz\\AppData\\Local', roaming: 'C:\\Users\\deniz\\AppData\\Roaming' };
  const msix = classifyDesktopProcess('C:\\Program Files\\WindowsApps\\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', 'win32');
  const store = classifyDesktopProcess('C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_1.2.3.0_x64__fnn82j28hfe8t\\app\\claude.exe', 'win32');
  const classic = classifyDesktopProcess('C:\\Users\\deniz\\AppData\\Local\\AnthropicClaude\\app-0.9.0\\claude.exe', 'win32');
  assert.deepEqual([msix, store, classic], [{ kind: 'msix', family: 'Claude_pzs8sxrjxfjjc' },
    { kind: 'msix', family: 'AnthropicPBC.Claude_fnn82j28hfe8t' }, { kind: 'classic' }]);
  for (const other of ['C:\\Users\\deniz\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\abc\\claude.exe',
    'C:\\Users\\deniz\\.local\\bin\\claude.exe', 'C:\\Program Files\\WindowsApps\\Contoso.Claude_1.0.0.0_x64__fnn82j28hfe8t\\claude.exe']) {
    assert.equal(classifyDesktopProcess(other, 'win32'), null, other);
  }
  assert.deepEqual(classifyDesktopProcess('/Applications/Claude.app/Contents/MacOS/Claude', 'darwin'), { kind: 'macos' });
  assert.equal(classifyDesktopProcess('/usr/local/bin/claude', 'darwin'), null);

  const packaged = `${env.local}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude`;
  const roamingFile = `${env.roaming}\\Claude\\claude_desktop_config.json`;
  const uses = (file, running, exists = () => true) => desktopUsesProfile(file, running, env, 'win32', exists);
  assert.equal(uses(`${packaged}\\claude_desktop_config.json`, [msix]), true);
  assert.equal(uses(`${env.local}\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json`, [msix]), true);
  assert.equal(uses(`${packaged}\\claude_desktop_config.json`, [store]), false, 'another family does not read this profile');
  assert.equal(uses(roamingFile, [msix]), false, 'the package reads its own copy once it exists');
  assert.equal(uses(roamingFile, [msix], file => file === packaged), true, 'a package profile without a config reads through to roaming');
  assert.equal(uses(roamingFile, [classic]), true);
  assert.equal(uses(roamingFile, []), false);
  assert.equal(desktopUsesProfile('/Users/deniz/Library/Application Support/Claude/claude_desktop_config.json', [{ kind: 'macos' }], {}, 'darwin'), true);
});

test('MSIX write virtualization is detected through a package LocalCache probe and leaves no files',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clivoxa-container-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Packages', 'Unrelated_1234567890123', 'LocalCache', 'Local'), { recursive: true });
    assert.equal(await windowsPackageContainer(root), null);
    assert.deepEqual((await fs.readdir(root)).sort(), ['Packages']);
    assert.equal(await windowsPackageContainer(path.join(root, 'absent')), null);
  });

test('Windows Store discovery enumerates actual package directories and ignores unrelated or uninitialized packages',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clivoxa-store-ü-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const profile = path.join(root, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(path.join(root, 'Packages', 'Claude_1234567890123'));
    await fs.mkdir(path.join(root, 'Packages', 'Unrelated_1234567890123', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
    await fs.writeFile(path.join(root, 'Packages', 'Claude_aaaaaaaaaaaaa'), 'not a directory');
    const found = discoverHosts({ home: root, env: { LOCALAPPDATA: root }, bins: {} });
    assert.equal(found.length, 1);
    assert.equal(found[0].file, path.join(profile, 'claude_desktop_config.json'));
    assert.equal((await fs.readdir(profile)).length, 0, 'discovery must not write a configuration');
    assert.deepEqual(discoverHosts({ home: root, env: { LOCALAPPDATA: path.join(root, 'absent') }, bins: {} }), []);
  });

test('Windows finds CLI and Desktop profiles using redirected, case-insensitive OS paths', () => {
  const existing = new Set(['D:\\Roaming\\Çağrı\\Claude']);
  const found = discoverHosts(options({ platform: 'win32', home: 'C:\\Users\\Çağrı',
    env: { AppData: 'D:\\Roaming\\Çağrı', codex_home: 'D:\\Codex Profile', CLAUDE_CONFIG_DIR: 'D:\\Claude Profile' },
    bins: { codex: 'C:\\tools\\codex.exe', claude: 'C:\\tools\\claude.exe' }, exists: file => existing.has(file) }));
  assert.deepEqual(found.map(({ id, file, role, host }) => ({ id, file, role, host })), [
    { id: 'claude-code', file: 'D:\\Claude Profile\\.claude.json', role: 'codex', host: 'claude-code' },
    { id: 'claude-desktop', file: 'D:\\Roaming\\Çağrı\\Claude\\claude_desktop_config.json', role: 'codex', host: 'desktop' },
    { id: 'codex', file: 'D:\\Codex Profile\\config.toml', role: 'claude', host: 'codex' },
  ]);
});

test('fresh macOS Desktop app installations use canonical config paths without requiring CLI hosts', () => {
  const existing = new Set(['/Applications/Claude.app', '/users/deniz/Applications/Codex.app']);
  const found = discoverHosts(options({ platform: 'darwin', exists: file => existing.has(file) }));
  assert.deepEqual(found.map(({ id, file }) => ({ id, file })), [
    { id: 'claude-desktop', file: '/users/deniz/Library/Application Support/Claude/claude_desktop_config.json' },
    { id: 'codex', file: '/users/deniz/.codex/config.toml' },
  ]);
});

test('Windows app executables establish fresh Desktop presence but missing APPDATA does not guess its profile', () => {
  const existing = new Set(['C:\\Local\\AnthropicClaude\\Claude.exe', 'C:\\Local\\Programs\\Codex\\Codex.exe']);
  const base = { platform: 'win32', home: 'C:\\Users\\deniz', env: { LOCALAPPDATA: 'C:\\Local', APPDATA: 'D:\\Roaming' },
    exists: file => existing.has(file) };
  assert.deepEqual(discoverHosts(options(base)).map(item => item.id), ['claude-desktop', 'codex']);
  assert.deepEqual(discoverHosts(options({ ...base, env: { LOCALAPPDATA: 'C:\\Local' } })).map(item => item.id), ['codex']);
});

test('discovery skips absent hosts and uses existing profiles without inventing Linux Desktop support', () => {
  assert.deepEqual(discoverHosts(options()), []);
  const existing = new Set(['/users/deniz/.claude.json', '/users/deniz/.codex', '/xdg/Claude']);
  const found = discoverHosts(options({ env: { XDG_CONFIG_HOME: '/xdg' }, exists: file => existing.has(file) }));
  assert.deepEqual(found.map(item => item.id), ['claude-code', 'claude-desktop', 'codex']);
  assert.equal(found[0].file, '/users/deniz/.claude.json');
  assert.equal(found[1].file, '/xdg/Claude/claude_desktop_config.json');
});

test('explicit provider profiles do not accidentally register the default profile', () => {
  const existing = new Set(['/users/deniz/.claude.json', '/users/deniz/.codex']);
  assert.deepEqual(discoverHosts(options({ env: { CLAUDE_CONFIG_DIR: '/other/claude', CODEX_HOME: '/other/codex' },
    exists: file => existing.has(file) })), []);
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) {
    assert.throws(() => discoverHosts(options({ env: { [name]: 'relative-secret-directory' } })), error => {
      assert.match(error.message, /absolute directory/);
      assert.doesNotMatch(error.message, /relative-secret-directory/);
      return true;
    });
  }
});

for (const id of ['claude-code', 'claude-desktop']) {
  test(`${id} preserves unrelated configuration, private settings and read ceiling during URL migration`, () => {
    const original = { theme: 'system', auth: { token: 'foreign-secret' }, mcpServers: {
      other: { command: 'other', env: { TOKEN: 'other-secret' } },
      clivoxa: { type: 'http', url: 'https://old.invalid', headers: { Authorization: 'obsolete-secret' },
        timeout: 333, disabled: true, env: { CLIVOXA_MAX_ACCESS: 'read', CLIVOXA_HOME: '/custom/state',
          CLAUDE_CONFIG_DIR: '/custom/claude', CODEX_HOME: '/custom/codex', CUSTOM: 'private', CODEX_BIN: '/old/codex' } },
    } };
    const text = '\uFEFF' + JSON.stringify(original, null, 2).replaceAll('\n', '\r\n');
    const result = renderHostConfig(host(id), text, launch);
    const parsed = JSON.parse(result);
    assert.deepEqual(parsed.auth, original.auth);
    assert.deepEqual(parsed.mcpServers.other, original.mcpServers.other);
    const ours = parsed.mcpServers.clivoxa;
    assert.equal(ours.env.CLIVOXA_MAX_ACCESS, 'read');
    assert.equal(ours.env.CUSTOM, 'private');
    assert.equal(ours.env.CLIVOXA_HOME, '/custom/state');
    assert.equal(ours.env.CLAUDE_CONFIG_DIR, '/custom/claude');
    assert.equal(ours.env.CODEX_HOME, '/custom/codex');
    assert.equal(ours.env.CODEX_BIN, '/bin/codex');
    assert.equal(ours.env.CLIVOXA_HOST, id === 'claude-code' ? 'claude-code' : 'desktop');
    assert.equal(ours.timeout, 333);
    assert.equal(ours.disabled, true);
    assert.equal(ours.url, undefined);
    assert.equal(ours.headers, undefined);
    assert.equal(ours.type, id === 'claude-code' ? 'stdio' : undefined);
    assert.equal(isHostEnabled(host(id), result), false);
    assert.ok(result.includes('\r\n'));
    assert.equal(renderHostConfig(host(id), result, launch), result);
    assert.deepEqual(readHostLaunch(host(id), result), { command: launch.command, args: launch.args, env: ours.env });
  });
}

test('setup preserves implicit old access defaults and gives new installations an explicit ceiling', () => {
  for (const oldHost of [undefined, 'desktop', 'unknown', 'claude-code', 'codex']) {
    const text = JSON.stringify({ mcpServers: { clivoxa: { command: 'old', env: oldHost ? { CLIVOXA_HOST: oldHost } : {} } } });
    const next = readHostLaunch(host('claude-code'), renderHostConfig(host('claude-code'), text, launch));
    assert.equal(next.env.CLIVOXA_MAX_ACCESS, ['claude-code', 'codex'].includes(oldHost) ? 'write' : 'read');
  }
  const fresh = readHostLaunch(host('claude-desktop'), renderHostConfig(host('claude-desktop'), '', launch));
  assert.equal(fresh.env.CLIVOXA_MAX_ACCESS, 'write');
  assert.equal(fresh.env.CLIVOXA_HOST, 'desktop');
});

test('TOML structural update preserves quoted foreign tables, large integers, dates, multiline strings and custom controls', () => {
  const original = `# User comments are preserved on subsequent no-op runs.
counter = 9223372036854775807
float_value = 1.0
started = 2026-01-02T03:04:05Z
instructions = '''Keep this header as text:
[mcp_servers.clivoxa]
'''
[mcp_servers."foreign.with.dots"]
command = "other"
[mcp_servers."foreign.with.dots".env]
TOKEN = "private-secret"
[mcp_servers.clivoxa]
command = "old"
enabled = false
startup_timeout_sec = 90
env_vars = ["OTHER"]
[mcp_servers.clivoxa.env]
CLIVOXA_MAX_ACCESS = "read"
CUSTOM = "private"
[mcp_servers.clivoxa.tools.special]
approval_mode = "prompt"
`;
  const result = renderHostConfig(host('codex'), original, launch);
  const parsed = parseToml(result, { integersAsBigInt: true });
  const before = parseToml(original, { integersAsBigInt: true });
  assert.equal(parsed.counter, 9223372036854775807n);
  assert.equal(parsed.float_value, 1);
  assert.deepEqual(parsed.started, before.started);
  assert.equal(parsed.instructions, before.instructions);
  assert.deepEqual(parsed.mcp_servers['foreign.with.dots'], before.mcp_servers['foreign.with.dots']);
  assert.equal(parsed.mcp_servers.clivoxa.startup_timeout_sec, 90n);
  assert.equal(parsed.mcp_servers.clivoxa.tool_timeout_sec, 120n);
  assert.deepEqual(parsed.mcp_servers.clivoxa.env_vars, ['OTHER']);
  assert.equal(parsed.mcp_servers.clivoxa.tools.special.approval_mode, 'prompt');
  assert.equal(parsed.mcp_servers.clivoxa.env.CLIVOXA_EXPOSE, 'claude');
  assert.equal(parsed.mcp_servers.clivoxa.env.CLIVOXA_MAX_ACCESS, 'read');
  assert.equal(isHostEnabled(host('codex'), result), false);
  const withComments = '# Preserve this comment exactly\n' + result;
  assert.equal(renderHostConfig(host('codex'), withComments, launch), withComments);
});

test('TOML values that cannot survive a structural rewrite fail closed', () => {
  assert.throws(() => renderHostConfig(host('codex'), 'float_value = -0.0\n', launch), /configuration is invalid/);
});

test('TOML inline/dotted MCP tables migrate safely and remove remote transport secrets only from our entry', () => {
  const text = 'mcp_servers.clivoxa = { url = "https://old.invalid", bearer_token_env_var = "SECRET", http_headers = { Authorization = "private" }, env = { CLIVOXA_MAX_ACCESS = "read" } }\n'
    + 'mcp_servers.other = { url = "https://keep.invalid", bearer_token_env_var = "KEEP" }\n';
  const parsed = parseToml(renderHostConfig(host('codex'), text, launch));
  assert.equal(parsed.mcp_servers.clivoxa.url, undefined);
  assert.equal(parsed.mcp_servers.clivoxa.http_headers, undefined);
  assert.equal(parsed.mcp_servers.clivoxa.bearer_token_env_var, undefined);
  assert.deepEqual(parsed.mcp_servers.other, { url: 'https://keep.invalid', bearer_token_env_var: 'KEEP' });
});

test('malformed configuration or unsupported access values fail without leaking configuration content', () => {
  for (const [id, text] of [
    ['claude-code', '{"secret-token":"DO-NOT-PRINT"'], ['claude-code', '[]'],
    ['claude-desktop', '{"mcpServers": []}'], ['claude-desktop', '{"mcpServers":{"clivoxa":false}}'],
    ['claude-code', '{"mcpServers":{"clivoxa":{"env":{"TOKEN":3}}}}'],
    ['claude-code', '{"mcpServers":{"clivoxa":{"env":{"CLIVOXA_MAX_ACCESS":"DO-NOT-PRINT"}}}}'],
    ['claude-code', '{"mcpServers":{"clivoxa":{"type":"DO-NOT-PRINT"}}}'],
    ['codex', 'secret-token = "DO-NOT-PRINT"\n[bad'], ['codex', 'mcp_servers = []'],
    ['codex', '[mcp_servers.clivoxa.env]\nTOKEN = 3'],
  ]) {
    assert.throws(() => renderHostConfig(host(id), text, launch), error => {
      assert.match(error.message, /configuration is invalid/);
      assert.doesNotMatch(error.message, /DO-NOT-PRINT|secret-token|TOKEN/);
      return true;
    });
  }
});

test('global Claude disable choices remain effective and malformed disabled flags fail closed', () => {
  const text = renderHostConfig(host('claude-code'), '{"disabledMcpServers":["clivoxa"]}', launch);
  assert.equal(isHostEnabled(host('claude-code'), text), false);
  assert.equal(isHostEnabled(host('codex'), ''), false);
  assert.throws(() => isHostEnabled(host('codex'), '[mcp_servers.clivoxa]\nenabled = "secret"'), /configuration is invalid/);
});

test('ownership fingerprint ignores unrelated entries and key ordering, detects user edits, and exposes no secrets', () => {
  const a = '{"mcpServers":{"clivoxa":{"command":"node","env":{"TOKEN":"private-secret","CLIVOXA_MAX_ACCESS":"read"}}}}';
  const b = '{"mcpServers":{"other":{"command":"foreign"},"clivoxa":{"env":{"CLIVOXA_MAX_ACCESS":"read","TOKEN":"private-secret"},"command":"node"}}}';
  const fingerprint = entryFingerprint(host('claude-code'), a);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(entryFingerprint(host('claude-code'), b), fingerprint);
  assert.notEqual(entryFingerprint(host('claude-code'), a.replace('read', 'write')), fingerprint);
  assert.equal(entryFingerprint(host('claude-code'), '{}'), null);
});

test('removal leaves foreign config and secrets intact and absent entries are a byte-preserving no-op', () => {
  for (const id of ['claude-code', 'claude-desktop', 'codex']) {
    const text = id === 'codex' ? 'other = "private"\n[mcp_servers.foreign]\ncommand = "keep"\n'
      : '{"other":"private","mcpServers":{"foreign":{"command":"keep"}}}';
    const updated = renderHostConfig(host(id), text, launch);
    const removed = removeHostEntry(host(id), updated);
    const parse = id === 'codex' ? parseToml : JSON.parse;
    assert.deepEqual(parse(removed), parse(text));
    assert.equal(entryFingerprint(host(id), removed), null);
    assert.equal(removeHostEntry(host(id), text), text);
  }
});

test('repair refreshes provider paths and removes obsolete optional binaries while retaining user preferences', () => {
  const oldEnv = {
    NODE_BIN:'/removed/node', CODEX_BIN:'/removed/codex', CLAUDE_BIN:'/removed/claude',
    CLIVOXA_USER_PATH:'/removed/node:/removed/provider', GIT_BIN:'/removed/git',
    CODEX_JS:'/removed/codex.mjs', CODEX_PATH_DIR:'/removed/codex-native',
    CLIVOXA_MAX_ACCESS:'read', CLIVOXA_HOME:'/custom/jobs', CLIVOXA_EXTRA_ROOTS:'/custom/project',
    CODEX_HOME:'/custom/codex', CLAUDE_CONFIG_DIR:'/custom/claude', CUSTOM:'keep this preference',
  };
  const replacement = {
    command:'/new/node', args:['/new/runtime/clivoxa.mjs'],
    env:{NODE_BIN:'/new/node', CODEX_BIN:'/new/codex', CLAUDE_BIN:'/new/claude',
      CLIVOXA_USER_PATH:'/new/node:/new/provider', CLIVOXA_MAX_ACCESS:'write'},
  };
  for (const id of ['claude-code', 'claude-desktop', 'codex']) {
    const original = id === 'codex'
      ? '[mcp_servers.clivoxa]\ncommand = "/removed/node"\nargs = []\n[mcp_servers.clivoxa.env]\n'
        + Object.entries(oldEnv).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('')
      : JSON.stringify({mcpServers:{clivoxa:{command:'/removed/node', args:[], env:oldEnv}}});
    const repaired = readHostLaunch(host(id), renderHostConfig(host(id), original, replacement));
    assert.equal(repaired.command, replacement.command);
    assert.deepEqual(repaired.args, replacement.args);
    for (const key of ['NODE_BIN', 'CODEX_BIN', 'CLAUDE_BIN', 'CLIVOXA_USER_PATH']) {
      assert.equal(repaired.env[key], replacement.env[key], `${id}: ${key} must use the current installation`);
    }
    for (const key of ['GIT_BIN', 'CODEX_JS', 'CODEX_PATH_DIR']) {
      assert.equal(Object.hasOwn(repaired.env, key), false, `${id}: ${key} cannot keep pointing at a removed binary`);
    }
    for (const key of ['CLIVOXA_MAX_ACCESS', 'CLIVOXA_HOME', 'CLIVOXA_EXTRA_ROOTS', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CUSTOM']) {
      assert.equal(repaired.env[key], oldEnv[key], `${id}: user preference ${key} must remain unchanged`);
    }
  }
});
