import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkHome, baseEnv, cleanupHome, DIST} from '../helpers/harness.mjs';
import {createWindowsProcesses} from '../../dist/system/platform/windows.js';
import {ancestryGuard} from '../../dist/security/guards.js';
import {refuseConstrainedPowerShell} from '../../dist/setup/setup.js';
import {aclFailure} from '../../dist/setup/windows-acl.js';

const UNVERIFIED = 'üst süreçler doğrulanamadı (güvenli tarafta kalındı)';
// A FullLanguage session may switch itself to ConstrainedLanguage; what follows then runs as under WDAC/AppLocker.
const CLM = "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';";
const constrained = (file, args) => {
  const i = args.indexOf('-Command');
  return spawnSync(file, i < 0 ? args : [...args.slice(0, i + 1), CLM + args[i + 1], ...args.slice(i + 2)], {encoding: 'utf8', windowsHide: true, timeout: 15_000});
};

test('Windows: under Constrained Language Mode the ancestry check still refuses, and names the cause', {skip: process.platform !== 'win32' && 'Windows PowerShell only'}, () => {
  const clm = createWindowsProcesses(constrained);
  assert.equal(clm.languageMode(), 'ConstrainedLanguage');
  assert.equal(clm.ancestorCommands(), null, 'the real ancestry script cannot run, so nothing is proven');
  const reason = ancestryGuard(clm);
  assert.match(reason, /ConstrainedLanguage/);
  assert.match(reason, /WDAC veya AppLocker/);
  assert.equal(createWindowsProcesses().languageMode(), 'FullLanguage', 'an ordinary session is read as FullLanguage');
});

test('the ancestry guard stays fail-closed; only a constrained PowerShell changes the reason', () => {
  const guard = (ancestors, mode) => ancestryGuard({ancestorCommands: () => ancestors, languageMode: () => mode});
  assert.equal(guard(null, 'FullLanguage'), UNVERIFIED);
  assert.equal(guard(null, null), UNVERIFIED, 'an unreadable mode keeps the generic refusal');
  assert.match(guard(null, 'ConstrainedLanguage'), /kısıtlı dil kipinde çalışıyor \(ConstrainedLanguage\)/);
  assert.match(guard(null, 'NoLanguage'), /NoLanguage/);
  assert.equal(guard(['"C:\\Program Files\\Claude\\claude.exe"'], 'ConstrainedLanguage'), null, 'the mode alone never refuses');
  assert.match(guard(['node clivoxa.mjs --clivoxa-runner job'], 'FullLanguage'), /runner/);
});

test('setup refuses a constrained PowerShell before changing anything; ACL failures name it too', () => {
  assert.throws(() => refuseConstrainedPowerShell(() => 'ConstrainedLanguage'), /ConstrainedLanguage.*WDAC veya AppLocker/s);
  assert.doesNotThrow(() => refuseConstrainedPowerShell(() => 'FullLanguage'));
  assert.doesNotThrow(() => refuseConstrainedPowerShell(() => null));
  const constrainedError = aclFailure('descriptor', () => 'ConstrainedLanguage');
  assert.equal(constrainedError.code, 'CONFIG_ACL_UNAVAILABLE', 'still the same failure for setup and uninstall');
  assert.match(constrainedError.message, /ConstrainedLanguage/);
  assert.match(aclFailure('descriptor', () => 'FullLanguage').message, /\(descriptor\)/);
});

test('a refusing server tells the host why it offers no tools', async (t) => {
  const h = mkHome();
  t.after(() => cleanupHome(h));
  const client = new Client({name: 'clivoxa-test', version: '1'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: [DIST], env: baseEnv(h, 'codex', {CLIVOXA_DEPTH: '1'}), stderr: 'pipe'}));
  try {
    assert.deepEqual((await client.listTools()).tools, [], 'still refuses');
    assert.match(client.getInstructions() ?? '', /^Clivoxa bu oturumda araç sunmuyor: CLIVOXA_DEPTH/);
  } finally {
    await client.close();
  }
});
