import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parse as parseToml, stringify as stringifyToml} from 'smol-toml';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ROOT, FAKE_CODEX, FAKE_CLAUDE, mkHome, cleanupHome} from '../helpers/harness.mjs';
import {systemEnvironment} from '../../dist/system/platform/index.js';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const within = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

function fixture() {
  const outer = mkHome();
  const home = path.join(outer.home, 'Kullanıcı Profili ş ı');
  fs.mkdirSync(home, {recursive:true});
  const env = {
    ...systemEnvironment(), HOME:home, USERPROFILE:home, PATH:path.dirname(process.execPath),
    APPDATA:path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA:path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME:path.join(home, 'Application Data'), CODEX_HOME:path.join(home, '.codex'),
    CODEX_BIN:FAKE_CODEX, CLAUDE_BIN:FAKE_CLAUDE, NODE_BIN:process.execPath,
    NPM_CONFIG_CACHE:path.join(outer.home, 'npm cache ü'),
    // A terminal credential must never be copied into persistent host configs.
    OPENAI_API_KEY:'fixture-terminal-key-not-for-persistence',
  };
  const files = {
    'claude-code':path.join(home, '.claude.json'),
    codex:path.join(env.CODEX_HOME, 'config.toml'),
  };
  fs.mkdirSync(env.CODEX_HOME, {recursive:true});
  fs.mkdirSync(path.join(home, '.claude'), {recursive:true});
  if (process.platform === 'win32') files['claude-desktop'] = path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') files['claude-desktop'] = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (files['claude-desktop']) fs.mkdirSync(path.dirname(files['claude-desktop']), {recursive:true});
  return {outer, home, env, files};
}

// Simulate npx's extracted package, including only files shipped to consumers.
// No source files, node_modules, caller cwd, or npm cache may be needed later.
function packageCopy(f) {
  const directory = path.join(f.env.NPM_CONFIG_CACHE, '_npx', 'clivoxa package');
  fs.mkdirSync(directory, {recursive:true});
  const manifest = readJson(path.join(ROOT, 'package.json'));
  // "!path" entries exclude a file from the package, as npm does.
  for (const name of ['package.json', ...manifest.files.filter(entry => !entry.startsWith('!'))]) {
    copyPayload(path.join(ROOT, name), path.join(directory, name));
  }
  for (const entry of manifest.files.filter(entry => entry.startsWith('!'))) fs.rmSync(path.join(directory, entry.slice(1)), {force:true});
  return path.join(directory, 'dist', 'clivoxa.mjs');
}

function copyPayload(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, {recursive:true});
    for (const name of fs.readdirSync(source)) copyPayload(path.join(source, name), path.join(destination, name));
  } else {
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, fs.readFileSync(source));
  }
}

function run(f, bundle, args) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd:f.outer.proj, env:f.env, encoding:'utf8', windowsHide:true, timeout:180_000,
    maxBuffer:2 * 1024 * 1024,
  });
}

function setup(f, bundle, args = []) {
  const result = run(f, bundle, ['setup', '--json', ...args]);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function readConfig(id, file) {
  const text = fs.readFileSync(file, 'utf8');
  return id === 'codex' ? parseToml(text) : JSON.parse(text);
}

function entry(id, config) {
  return (id === 'codex' ? config.mcp_servers : config.mcpServers)?.clivoxa;
}

function writeConfig(id, file, config) {
  fs.writeFileSync(file, id === 'codex' ? stringifyToml(config) : JSON.stringify(config, null, 2) + '\n');
}

async function checkSavedLaunch(f, launch, role) {
  const transport = new StdioClientTransport({
    command:launch.command, args:launch.args,
    env:{...systemEnvironment(f.env), HOME:f.home, USERPROFILE:f.home, PATH:'', ...launch.env},
    cwd:f.outer.proj, stderr:'pipe',
  });
  const diagnostics = [];
  transport.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
  const client = new Client({name:'clivoxa-portable-setup-test', version:'1'});
  try {
    await client.connect(transport, {timeout:35_000});
    assert.equal(client.getServerVersion()?.name, 'clivoxa');
    const tools = (await client.listTools({}, {timeout:35_000})).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, [`ask_${role}`, 'cancel_job', 'get_job', 'list_jobs', 'list_models'].sort(), diagnostics.join(''));
    const response = await client.callTool({name:'list_models', arguments:{refresh:true}}, undefined, {timeout:35_000});
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const catalogue = JSON.parse(response.content.find(item => item.type === 'text').text);
    assert.equal(catalogue.target, role);
    assert.ok(catalogue.models.length > 0);
  } finally {
    await client.close();
    await transport.close();
  }
}

test('one setup installs durable opposite-role MCPs, survives deleted npx cache, preserves preferences, and uninstalls conservatively', {timeout:600_000}, async () => {
  const f = fixture();
  try {
    const foreign = {command:process.execPath, args:['foreign-server.mjs'], env:{FOREIGN_SETTING:'preserve me'}};
    writeJson(f.files['claude-code'], {theme:'dark', mcpServers:{existing:foreign}});
    fs.writeFileSync(f.files.codex, '# User-owned settings\nmodel = "user-model"\n[mcp_servers.existing]\ncommand = "foreign-server"\n');
    if (f.files['claude-desktop']) writeJson(f.files['claude-desktop'], {preferences:{menuBarEnabled:false}, mcpServers:{existing:foreign}});
    const report = setup(f, packageCopy(f));
    assert.deepEqual(report.hosts.map(host => host.id).sort(), Object.keys(f.files).sort());
    assert.deepEqual(report.skipped, []);
    assert.equal(report.ready, true);
    assert.ok(path.isAbsolute(report.runtime));
    assert.equal(within(report.runtime, f.env.NPM_CONFIG_CACHE), false, 'runtime cannot depend on npx cache');
    assert.equal(within(report.runtime, path.join(f.home, '.clivoxa')), false, 'runtime must stay outside job state');
    assert.equal(within(report.runtime, ROOT), false, 'runtime must stay outside the source checkout');
    assert.ok(within(report.runtime, f.home), 'installation must be scoped to this user profile');
    for (const resource of ['dist/clivoxa.mjs', 'dist/THIRD-PARTY-NOTICES.txt', 'scripts/lib/verify-sandbox.mjs', 'scripts/lib/verify-claude.mjs', 'package.json', 'LICENSE']) {
      assert.ok(fs.existsSync(path.join(report.runtime, resource)), `missing runtime resource: ${resource}`);
    }

    // Delete the entire extracted package before exercising the saved host commands.
    fs.rmSync(f.env.NPM_CONFIG_CACHE, {recursive:true, force:true});
    for (const host of report.hosts) {
      assert.equal(host.file, f.files[host.id]);
      assert.equal(host.tools, 5);
      assert.equal(host.catalogue, 'available');
      assert.equal(host.hostConnection, 'restart-required', 'a subprocess test does not prove a GUI connected');
      const config = readConfig(host.id, host.file);
      const launch = entry(host.id, config);
      const role = host.id === 'codex' ? 'claude' : 'codex';
      assert.equal(launch.command, fs.realpathSync.native(process.execPath));
      assert.ok(path.isAbsolute(launch.args[0]));
      assert.ok(within(launch.args[0], report.runtime));
      assert.equal(launch.env.CLIVOXA_EXPOSE, role);
      assert.equal(launch.env.CLIVOXA_HOST, host.id === 'claude-desktop' ? 'desktop' : host.id);
      assert.equal(launch.env.CLIVOXA_MAX_ACCESS, 'write');
      assert.equal(launch.env.OPENAI_API_KEY, undefined);
      assert.ok(!fs.readFileSync(host.file, 'utf8').includes(f.env.OPENAI_API_KEY));
      await checkSavedLaunch(f, launch, role);

      // These are user choices, not setup defaults that an upgrade may overwrite.
      launch.env.CLIVOXA_MAX_ACCESS = 'read';
      launch.env.CLIVOXA_MAX_RUNNING_TOTAL = '2';
      launch.env.USER_CUSTOM_SETTING = 'özel tercih';
      if (host.id === 'codex') config.mcp_servers.clivoxa.tool_timeout_sec = 180;
      writeConfig(host.id, host.file, config);
    }
    assert.equal(readJson(f.files['claude-code']).theme, 'dark');
    assert.deepEqual(readJson(f.files['claude-code']).mcpServers.existing, foreign);
    assert.equal(readConfig('codex', f.files.codex).model, 'user-model');
    assert.equal(readConfig('codex', f.files.codex).mcp_servers.existing.command, 'foreign-server');
    if (f.files['claude-desktop']) {
      const config = readJson(f.files['claude-desktop']);
      assert.deepEqual(config.preferences, {menuBarEnabled:false});
      assert.deepEqual(config.mcpServers.existing, foreign);
    }

    const repeated = setup(f, packageCopy(f));
    assert.equal(repeated.runtime, report.runtime, 'reinstalling identical package must reuse its verified runtime');
    for (const [id, file] of Object.entries(f.files)) {
      const launch = entry(id, readConfig(id, file));
      assert.equal(launch.env.CLIVOXA_MAX_ACCESS, 'read');
      assert.equal(launch.env.CLIVOXA_MAX_RUNNING_TOTAL, '2');
      assert.equal(launch.env.USER_CUSTOM_SETTING, 'özel tercih');
    }
    assert.equal(readConfig('codex', f.files.codex).mcp_servers.clivoxa.tool_timeout_sec, 180);
    const stable = Object.fromEntries(Object.entries(f.files).map(([id, file]) => [id, fs.readFileSync(file, 'utf8')]));
    const idempotent = setup(f, packageCopy(f));
    assert.ok(idempotent.hosts.every(host => host.changed === false));
    for (const [id, file] of Object.entries(f.files)) assert.equal(fs.readFileSync(file, 'utf8'), stable[id]);

    // An entry changed after setup belongs to the user; unchanged entries can be removed.
    const custom = readJson(f.files['claude-code']);
    custom.mcpServers.clivoxa.env.USER_CUSTOM_SETTING = 'changed after installation';
    writeJson(f.files['claude-code'], custom);
    const archive = path.join(f.home, '.clivoxa', 'jobs', 'retained-job', 'answer.txt');
    fs.mkdirSync(path.dirname(archive), {recursive:true});
    fs.writeFileSync(archive, 'Existing job output\n');
    fs.rmSync(f.env.NPM_CONFIG_CACHE, {recursive:true, force:true});
    const removed = run(f, path.join(report.runtime, 'dist', 'clivoxa.mjs'), ['uninstall']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.deepEqual(readJson(f.files['claude-code']), custom);
    for (const [id, file] of Object.entries(f.files)) {
      if (id === 'claude-code') continue;
      const config = readConfig(id, file);
      assert.equal(entry(id, config), undefined);
      assert.ok((id === 'codex' ? config.mcp_servers : config.mcpServers).existing);
    }
    assert.equal(fs.readFileSync(archive, 'utf8'), 'Existing job output\n');
    assert.ok(fs.existsSync(path.join(report.runtime, 'dist', 'clivoxa.mjs')), 'running jobs may still depend on this runtime');
  } finally {
    cleanupHome(f.outer);
  }
});

test('malformed existing JSON or TOML stops setup before changing any host registration', {timeout:240_000}, () => {
  for (const malformed of ['claude-code', 'codex']) {
    const f = fixture();
    try {
      writeJson(f.files['claude-code'], {mcpServers:{existing:{command:'user-owned'}}});
      fs.writeFileSync(f.files.codex, '[mcp_servers.existing]\ncommand = "user-owned"\n');
      if (f.files['claude-desktop']) writeJson(f.files['claude-desktop'], {mcpServers:{existing:{command:'user-owned'}}});
      fs.writeFileSync(f.files[malformed], malformed === 'codex' ? '[invalid\n' : '{"mcpServers":');
      const before = Object.fromEntries(Object.entries(f.files).map(([id, file]) => [id, fs.readFileSync(file, 'utf8')]));
      const result = run(f, packageCopy(f), ['setup', '--json']);
      assert.notEqual(result.status, 0, 'invalid config must never be replaced with a fresh config');
      for (const [id, file] of Object.entries(f.files)) assert.equal(fs.readFileSync(file, 'utf8'), before[id]);
      for (const file of Object.values(f.files)) {
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => /\.clivoxa-(?:backup|stage|restore)-/.test(name)), [], 'preflight validation must precede config backups or writes');
      }
    } finally {
      cleanupHome(f.outer);
    }
  }
});

test('fresh setup honors a read ceiling without manufacturing a Claude profile override', {timeout:180_000}, () => {
  const f = fixture();
  try {
    f.env.CLIVOXA_MAX_ACCESS = 'read';
    delete f.env.CLAUDE_CONFIG_DIR;
    const report = setup(f, path.join(ROOT, 'dist', 'clivoxa.mjs'), ['claude-code', '--local']);
    assert.deepEqual(report.hosts.map(host => host.id), ['claude-code']);
    assert.equal(report.hosts[0].file, path.join(f.home, '.claude.json'));
    assert.equal(report.hosts[0].catalogue, 'available');
    const launch = readJson(report.hosts[0].file).mcpServers.clivoxa;
    assert.equal(launch.env.CLIVOXA_MAX_ACCESS, 'read');
    assert.equal(Object.hasOwn(launch.env, 'CLAUDE_CONFIG_DIR'), false,
      'an invented override would relocate Claude global settings away from ~/.claude.json');
    assert.equal(fs.existsSync(path.join(f.home, '.claude', '.claude.json')), false);
    assert.equal(fs.existsSync(f.files.codex), false, 'selecting Claude Code must not register a different host');
  } finally {
    cleanupHome(f.outer);
  }
});

test('setup keeps configuration backups in private state', {timeout:240_000}, () => {
  const f = fixture();
  try {
    delete f.env.CLAUDE_CONFIG_DIR;
    const config = path.join(f.home, '.claude.json');
    writeJson(config, {theme:'dark'});
    setup(f, path.join(ROOT, 'dist', 'clivoxa.mjs'), ['claude-code', '--local']);
    assert.deepEqual(fs.readdirSync(f.home).filter(name => name.startsWith('.claude.json.')), [], 'no readable copy of the config stays next to it');
    const state = f.env.CLIVOXA_HOME ?? path.join(f.home, '.clivoxa');
    const runs = fs.readdirSync(path.join(state, 'backups'));
    assert.equal(runs.length, 1, 'this setup backed up ~/.claude.json in private state');
  } finally {
    cleanupHome(f.outer);
  }
});

test('--max-access replaces the recorded ceiling; a plain setup keeps it and never raises it', {timeout:240_000}, () => {
  const f = fixture();
  try {
    delete f.env.CLAUDE_CONFIG_DIR;
    const bundle = path.join(ROOT, 'dist', 'clivoxa.mjs');
    const ceiling = () => readJson(path.join(f.home, '.claude.json')).mcpServers.clivoxa.env.CLIVOXA_MAX_ACCESS;
    setup(f, bundle, ['claude-code', '--local']);
    assert.equal(ceiling(), 'write');
    setup(f, bundle, ['claude-code', '--local', '--max-access', 'read']);
    assert.equal(ceiling(), 'read');
    f.env.CLIVOXA_MAX_ACCESS = 'write'; // inherited terminal env is not a decision
    setup(f, bundle, ['claude-code', '--local']);
    assert.equal(ceiling(), 'read');
    setup(f, bundle, ['claude-code', '--local', '--max-access', 'write']);
    assert.equal(ceiling(), 'write');
    const bad = run(f, bundle, ['setup', '--json', '--max-access', 'admin']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--max-access must be read or write/);
  } finally {
    cleanupHome(f.outer);
  }
});

test('Windows: setup registers where Claude Code and Codex read, even when HOME points elsewhere', {timeout:240_000, skip:process.platform !== 'win32' ? 'only the Windows CLIs ignore HOME' : false}, async () => {
  const f = fixture();
  try {
    // HOME set for Git or Emacs; Node's os.homedir() (Claude Code) and Codex still use the user profile.
    const shellHome = path.join(f.outer.home, 'shell home');
    fs.mkdirSync(shellHome, {recursive:true});
    f.env.HOME = shellHome;
    delete f.env.CODEX_HOME;
    delete f.env.CLAUDE_CONFIG_DIR;
    const bundle = path.join(ROOT, 'dist', 'clivoxa.mjs');
    const claude = setup(f, bundle, ['claude-code', '--local']);
    assert.equal(claude.hosts[0].file, f.files['claude-code']);
    const codex = setup(f, bundle, ['codex', '--local']);
    assert.equal(codex.hosts[0].file, f.files.codex);
    for (const {id, file} of [claude.hosts[0], codex.hosts[0]]) {
      const launch = entry(id, readConfig(id, file));
      assert.equal(launch.env.CODEX_HOME, path.join(f.home, '.codex'), 'the persisted Codex home is the one Codex reads');
    }
    assert.equal(fs.existsSync(path.join(shellHome, '.claude.json')), false, 'Claude Code never reads HOME\\.claude.json on Windows');
    assert.equal(fs.existsSync(path.join(shellHome, '.codex', 'config.toml')), false, 'Codex never reads HOME\\.codex on Windows');
  } finally {
    cleanupHome(f.outer);
  }
});
