import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readSnapshot, applyChanges, withSetupLock} from '../../dist/setup/config-transaction.js';
import {createWindowsPrivateFile, readWindowsDacl} from '../../dist/setup/windows-acl.js';

const moduleURL = new URL('../../dist/setup/config-transaction.js', import.meta.url).href;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clivoxa setup ü-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('configuration updates have private unique backups and preserve original permission bits', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  const original = '{"other-server":{"secret":"do-not-log-this"}}\n';
  await fs.writeFile(file, original, {mode: 0o640});
  if (process.platform !== 'win32') await fs.chmod(file, 0o640);
  const before = await readSnapshot(file);
  let tx;
  try { tx = await applyChanges([{snapshot: before, text: original.replace('other-server', 'preserved-server')}]); }
  catch (error) {
    if (process.platform === 'win32') assert.equal((await readSnapshot(file)).windowsDacl, before.windowsDacl, error.message);
    throw error;
  }
  assert.equal(tx.changedFiles.length, 1);
  assert.equal(await fs.realpath(tx.changedFiles[0]), await fs.realpath(file));
  assert.equal(tx.backups.length, 1);
  assert.equal(await fs.readFile(tx.backups[0].backupFile, 'utf8'), original);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(tx.backups[0].backupFile)).mode & 0o777, 0o600);
  }
  await tx.commit();
  await tx.rollback();
  assert.match(await fs.readFile(file, 'utf8'), /preserved-server/);
  const again = await applyChanges([{snapshot: await readSnapshot(file), text: original}]);
  assert.notEqual(tx.backups[0].backupFile, again.backups[0].backupFile);
  await again.commit();
});

test('with a backup directory, backups go there with an index and never next to the configuration', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  const backups = path.join(root, 'state', 'backups');
  await fs.writeFile(file, '{"secret":"token"}\n');
  const tx = await applyChanges([{snapshot: await readSnapshot(file), text: '{"secret":"token","added":1}\n'}], {backupDir: backups});
  await tx.commit();
  assert.ok(tx.backups[0].backupFile.startsWith(backups + path.sep), tx.backups[0].backupFile);
  assert.equal(await fs.readFile(tx.backups[0].backupFile, 'utf8'), '{"secret":"token"}\n');
  assert.deepEqual((await fs.readdir(root)).filter((n) => n.startsWith('config.json.')), [], 'no copy of the secret next to it');
  const index = JSON.parse(await fs.readFile(path.join(path.dirname(tx.backups[0].backupFile), 'index.json'), 'utf8'));
  assert.deepEqual(index, [{file, backupFile: tx.backups[0].backupFile}]);
});

test('rollback restores exact original bytes including BOM and removes only new files it installed', async t => {
  const root = await fixture(t);
  const existing = path.join(root, 'existing.json');
  const fresh = path.join(root, 'nested', 'new.json');
  const original = '\ufeff{ "secret": "kept", "other": true }\r\n';
  await fs.writeFile(existing, original);
  const tx = await applyChanges([
    {snapshot: await readSnapshot(existing), text: '{"changed":true}\n'},
    {snapshot: await readSnapshot(fresh), text: '{}\n'},
  ]);
  assert.equal(await fs.readFile(fresh, 'utf8'), '{}\n');
  await tx.rollback();
  assert.equal(await fs.readFile(existing, 'utf8'), original);
  await assert.rejects(fs.stat(fresh), {code: 'ENOENT'});
  await tx.rollback();
});

test('identical setup does not rewrite, reformat, or back up configuration', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{  "existing": true }\r\n');
  const before = await readSnapshot(file);
  const tx = await applyChanges([{snapshot: before, text: before.text}]);
  assert.deepEqual(tx.changedFiles, []);
  assert.deepEqual(tx.backups, []);
  assert.deepEqual(await readSnapshot(file), before);
  assert.deepEqual(await fs.readdir(root), ['config.json']);
  await tx.commit();
});

test('stale snapshots abort the whole batch before touching another configuration or creating backups', async t => {
  const root = await fixture(t);
  const first = path.join(root, 'first.json');
  const second = path.join(root, 'second.json');
  await fs.writeFile(first, '{}');
  await fs.writeFile(second, '{}');
  const firstSnapshot = await readSnapshot(first);
  const secondSnapshot = await readSnapshot(second);
  const secret = '{"apiKey":"private-concurrent-edit"}';
  await fs.writeFile(second, secret);
  await assert.rejects(applyChanges([
    {snapshot: firstSnapshot, text: '{"changed":true}'},
    {snapshot: secondSnapshot, text: '{"changed":true}'},
  ]), error => error.code === 'CONFIG_CHANGED' && !error.message.includes('private-concurrent-edit'));
  assert.equal(await fs.readFile(first, 'utf8'), '{}');
  assert.equal(await fs.readFile(second, 'utf8'), secret);
  assert.deepEqual((await fs.readdir(root)).sort(), ['first.json', 'second.json']);
});

test('interleaved setup and host edits are never overwritten during apply or rollback', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  const other = path.join(root, 'other.json');
  await fs.writeFile(file, '{"initial":1}');
  await fs.writeFile(other, '{"other":1}');
  const older = await readSnapshot(file);
  const tx = await applyChanges([
    {snapshot: older, text: '{"installed":1}'},
    {snapshot: await readSnapshot(other), text: '{"installed":2}'},
  ]);
  await assert.rejects(applyChanges([{snapshot: older, text: '{"stale":true}'}]), {code: 'CONFIG_CHANGED'});
  await fs.writeFile(file, '{"desktop-edit":true}');
  await assert.rejects(tx.rollback(), {code: 'CONFIG_ROLLBACK_FAILED'});
  assert.equal(await fs.readFile(file, 'utf8'), '{"desktop-edit":true}');
  assert.equal(await fs.readFile(other, 'utf8'), '{"other":1}');
  assert.equal(await fs.readFile(tx.backups[0].backupFile, 'utf8'), '{"initial":1}');
});

test('same-byte replacement by another writer is detected by file identity', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{}');
  const snapshot = await readSnapshot(file);
  const replacement = path.join(root, 'replacement');
  await fs.writeFile(replacement, '{}');
  await fs.rename(replacement, file);
  await assert.rejects(applyChanges([{snapshot, text: '{"installed":true}'}]), {code: 'CONFIG_CHANGED'});
});

test('distinct files are never mistaken for one another (Windows file IDs exceed 2^53)', async t => {
  const root = await fixture(t);
  // Files created together get neighbouring NTFS IDs; as plain numbers some of them round alike.
  const files = [];
  for (let i = 0; i < 64; i++) {
    files.push(path.join(root, `config-${i}.json`));
    await fs.writeFile(files[i], '{}');
  }
  const changes = await Promise.all(files.map(async file => ({snapshot: await readSnapshot(file), text: '{"installed":true}'})));
  const tx = await applyChanges(changes);
  await tx.commit();
  for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), '{"installed":true}');
  for (const backup of tx.backups) await fs.rm(backup.backupFile, {force: true});
});

test('commit detects host edits during verification, including unchanged configurations', async t => {
  const root = await fixture(t);
  for (const edited of ['updated', 'unchanged']) {
    const updated = path.join(root, `${edited}-updated.json`);
    const unchanged = path.join(root, `${edited}-unchanged.json`);
    await fs.writeFile(updated, '{"before":true}');
    await fs.writeFile(unchanged, '{"untouched":true}');
    const tx = await applyChanges([
      {snapshot: await readSnapshot(updated), text: '{"installed":true}'},
      {snapshot: await readSnapshot(unchanged), text: '{"untouched":true}'},
    ]);
    const editedFile = edited === 'updated' ? updated : unchanged;
    await fs.writeFile(editedFile, '{"desktop-edit":true}');
    await assert.rejects(tx.commit(), {code: 'CONFIG_CHANGED'});
    if (edited === 'updated') await assert.rejects(tx.rollback(), {code: 'CONFIG_ROLLBACK_FAILED'});
    else {
      await tx.rollback();
      assert.equal(await fs.readFile(updated, 'utf8'), '{"before":true}');
    }
    assert.equal(await fs.readFile(editedFile, 'utf8'), '{"desktop-edit":true}');
  }
});

test('new configuration appearing after inspection is preserved', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  const snapshot = await readSnapshot(file);
  await fs.writeFile(file, '{"host-created":true}');
  await assert.rejects(applyChanges([{snapshot, text: '{}'}]), {code: 'CONFIG_CHANGED'});
  assert.equal(await fs.readFile(file, 'utf8'), '{"host-created":true}');
});

test('new-file rollback preserves a subsequent replacement by the host', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'new.json');
  const tx = await applyChanges([{snapshot: await readSnapshot(file), text: '{}'}]);
  await fs.writeFile(file, '{"desktop-change":true}');
  await assert.rejects(tx.rollback(), {code: 'CONFIG_ROLLBACK_FAILED'});
  assert.equal(await fs.readFile(file, 'utf8'), '{"desktop-change":true}');
});

test('symlinked profile directories remain links, and retargeting invalidates their snapshots', async t => {
  const root = await fixture(t);
  const real = path.join(root, 'real-profile');
  const other = path.join(root, 'other-profile');
  const link = path.join(root, 'profile');
  await fs.mkdir(real); await fs.mkdir(other);
  await fs.writeFile(path.join(real, 'config.json'), '{"real":true}');
  await fs.writeFile(path.join(other, 'config.json'), '{"other":true}');
  await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(link, 'config.json');
  const tx = await applyChanges([{snapshot: await readSnapshot(file), text: '{"installed":true}'}]);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  await tx.rollback();
  assert.equal(await fs.readFile(file, 'utf8'), '{"real":true}');
  const snapshot = await readSnapshot(file);
  await fs.unlink(link);
  await fs.symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyChanges([{snapshot, text: '{"wrong-target":true}'}]), {code: 'CONFIG_CHANGED'});
  assert.equal(await fs.readFile(path.join(other, 'config.json'), 'utf8'), '{"other":true}');
});

test('incompatible files, hard links and invalid UTF-8 fail without exposing contents', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x61]));
  await assert.rejects(readSnapshot(file), {code: 'CONFIG_ENCODING'});
  await fs.writeFile(file, '{}');
  await fs.link(file, path.join(root, 'hardlink.json'));
  await assert.rejects(readSnapshot(file), {code: 'CONFIG_INCOMPATIBLE'});
  await assert.rejects(readSnapshot(root), error => ['CONFIG_INCOMPATIBLE', 'CONFIG_UNREADABLE'].includes(error.code));
});

test('a later staging failure restores prior files and does not alter restrictive permissions', {skip: process.platform === 'win32' ? 'POSIX directory permission fixture' : false}, async t => {
  const root = await fixture(t);
  const first = path.join(root, 'first.json');
  const protectedDir = path.join(root, 'no-write');
  await fs.mkdir(protectedDir);
  const second = path.join(protectedDir, 'second.json');
  await fs.writeFile(first, '{"first":true}');
  await fs.writeFile(second, '{"second":true}');
  const snapshots = await Promise.all([readSnapshot(first), readSnapshot(second)]);
  await fs.chmod(protectedDir, 0o500);
  try {
    await assert.rejects(applyChanges(snapshots.map(snapshot => ({snapshot, text: '{"installed":true}'}))), {code: 'CONFIG_WRITE_FAILED'});
    assert.equal(await fs.readFile(first, 'utf8'), '{"first":true}');
    assert.equal(await fs.readFile(second, 'utf8'), '{"second":true}');
    assert.equal((await fs.stat(protectedDir)).mode & 0o777, 0o500);
  } finally {await fs.chmod(protectedDir, 0o700);}
});

test('parallel setup calls serialize complete read-modify-verify transactions without losing updates', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'counter.json');
  await fs.writeFile(file, '0');
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({length: 4}, () => withSetupLock(root, async () => {
    active++; peak = Math.max(peak, active);
    const snapshot = await readSnapshot(file);
    await delay(15);
    const tx = await applyChanges([{snapshot, text: String(Number(snapshot.text) + 1)}]);
    await tx.commit();
    active--;
  }, {timeoutMs: process.platform === 'win32' ? 60_000 : 10_000})));
  assert.equal(peak, 1);
  assert.equal(await fs.readFile(file, 'utf8'), '4');
  await assert.rejects(fs.lstat(path.join(root, '.setup.lock')), {code: 'ENOENT'});
});

test('a live setup lock times out without removing or replacing its owner', async t => {
  const root = await fixture(t);
  await withSetupLock(root, async () => {
    const ownerFile = path.join(root, '.setup.lock', 'owner.json');
    const before = await fs.readFile(ownerFile, 'utf8');
    await assert.rejects(withSetupLock(root, async () => assert.fail('must not enter'), {timeoutMs: 30}), {code: 'SETUP_LOCK_BUSY'});
    assert.equal(await fs.readFile(ownerFile, 'utf8'), before);
  });
});

test('setup recovers a lock left by a genuinely terminated process', async t => {
  const root = await fixture(t);
  const script = `import {withSetupLock} from ${JSON.stringify(moduleURL)}; await withSetupLock(process.argv[1], async () => {process.stdout.write('locked\\n'); await new Promise(() => {setInterval(() => {}, 1000);});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  let exited = false;
  const closed = once(child, 'close').then(() => {exited = true;});
  t.after(async () => {if (!exited) child.kill('SIGKILL'); await closed;});
  let readyTimer;
  try {
    await Promise.race([
      once(child.stdout, 'data').then(([data]) => assert.match(data.toString(), /locked/)),
      closed.then(() => assert.fail('lock fixture exited before acquiring its lock')),
      new Promise((_, reject) => {readyTimer = setTimeout(() => reject(new Error('lock fixture did not become ready')), 5000);}),
    ]);
  } finally {clearTimeout(readyTimer);}
  child.kill('SIGKILL');
  await closed;
  let entered = false;
  await withSetupLock(root, async () => {entered = true;});
  assert.equal(entered, true);
  await assert.rejects(fs.lstat(path.join(root, '.setup.lock')), {code: 'ENOENT'});
});

test('incomplete and foreign-host locks remain untouched, and action errors release owned locks', async t => {
  const root = await fixture(t);
  const lock = path.join(root, '.setup.lock');
  await fs.mkdir(lock);
  await assert.rejects(withSetupLock(root, async () => {}, {timeoutMs: 0}), {code: 'SETUP_LOCK_BUSY'});
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: 99999999, host: 'another-machine.invalid', token: 'foreign'}));
  await assert.rejects(withSetupLock(root, async () => {}, {timeoutMs: 0}), {code: 'SETUP_LOCK_BUSY'});
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).token, 'foreign');
  await fs.rm(lock, {recursive: true});
  const expected = new Error('fixture failure');
  await assert.rejects(withSetupLock(root, async () => {throw expected;}), error => error === expected);
  await assert.rejects(fs.lstat(lock), {code: 'ENOENT'});
});

test('a symlink in place of the setup lock is refused without changing its target', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'another-directory');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'owner.json'), '{"preserve":"me"}');
  await fs.symlink(target, path.join(root, '.setup.lock'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(withSetupLock(root, async () => {}, {timeoutMs: 0}), {code: 'SETUP_LOCK_INVALID'});
  assert.equal(await fs.readFile(path.join(target, 'owner.json'), 'utf8'), '{"preserve":"me"}');
});

function windowsFixture(script, files) {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const shell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const fixed = `$ErrorActionPreference='Stop'; $files=@(${Object.keys(files).map(key => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${key}))`).join(',')}); ${script}`;
  return execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixed, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: {...process.env, ...Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.from(value, 'utf8').toString('base64')]))},
  });
}

const windowsOnly = {skip: process.platform === 'win32' ? false : 'Native Windows DACL contract'};

test('Windows accepts inheritance bookkeeping changes without changing unprotected access rules', windowsOnly, async t => {
  const root = await fixture(t);
  const requested = windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $parent=[Security.AccessControl.DirectorySecurity]::new();
    $parent.SetAccessRuleProtection($true,$false);
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));
    [IO.Directory]::SetAccessControl($files[0],$parent);
    [Console]::Write('D:AI(A;;FA;;;'+$sid.Value+')');
  `, {CLIVOXA_TEST_ROOT:root});
  const file = path.join(root, 'unprotected.json');
  const actual = await createWindowsPrivateFile(file, requested);
  assert.equal(actual, await readWindowsDacl(file));
  assert.doesNotMatch(actual, /^D:[^(]*AI/);
  const rules = windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $security=[IO.File]::GetAccessControl($files[0]);
    $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
    if ($security.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].IsInherited) {throw 'Access rules or inheritance policy changed';}
    [Console]::Write('unchanged');
  `, {CLIVOXA_TEST_FILE:file});
  assert.equal(rules, 'unchanged');
});

test('Windows rejects meaningful inheritance or rule changes before writing content', windowsOnly, async t => {
  const root = await fixture(t);
  const requested = windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
    $flags=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;
    $parent=[Security.AccessControl.DirectorySecurity]::new();
    $parent.SetAccessRuleProtection($true,$false);
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::Read,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
    [IO.Directory]::SetAccessControl($files[0],$parent);
    [Console]::Write('D:AI(A;;FA;;;'+$sid.Value+')');
  `, {CLIVOXA_TEST_ROOT:root});
  const file = path.join(root, 'must-not-contain-secrets.json');
  await assert.rejects(createWindowsPrivateFile(file, requested), error => error.code === 'CONFIG_ACL_UNAVAILABLE' && /\(verify_(?:inheritance|rule_count|rules)\)/.test(error.message));
  assert.equal((await fs.stat(file)).size, 0);
  const changedPolicy = windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $security=[IO.File]::GetAccessControl($files[0]);
    $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
    $sddl=$security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);
    $same= !$security.AreAccessRulesProtected -and $sddl -notmatch '^D:[^(]*AR' -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid -and $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and !$rules[0].IsInherited;
    if ($same) {throw 'Fixture did not introduce a meaningful policy or access-rule change';}
    [Console]::Write('rejected before content');
  `, {CLIVOXA_TEST_FILE:file});
  assert.equal(changedPolicy, 'rejected before content');
});

test('Windows treats an exclusively opened setup owner as busy without reclaiming its lock', windowsOnly, async t => {
  const root = await fixture(t);
  await withSetupLock(root, async () => {
    const ownerFile = path.join(root, '.setup.lock', 'owner.json');
    const original = await fs.readFile(ownerFile, 'utf8');
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const shell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CLIVOXA_TEST_OWNER)); $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try {[Console]::WriteLine('locked'); [Console]::In.ReadLine() | Out-Null;} finally {$stream.Dispose();}`;
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env:{...process.env, CLIVOXA_TEST_OWNER:Buffer.from(ownerFile, 'utf8').toString('base64')}, windowsHide:true, stdio:['pipe','pipe','pipe'],
    });
    const closed = once(child, 'close');
    let readyTimer;
    try {
      await Promise.race([
        once(child.stdout, 'data').then(([chunk]) => assert.match(String(chunk), /locked/)),
        closed.then(() => assert.fail('exclusive-lock fixture exited early')),
        new Promise((_, reject) => {readyTimer=setTimeout(() => reject(new Error('exclusive-lock fixture did not start')),15_000);}),
      ]);
      await assert.rejects(withSetupLock(root, async () => assert.fail('must not enter'), {timeoutMs:100}), {code:'SETUP_LOCK_BUSY'});
    } finally {
      clearTimeout(readyTimer);
      child.stdin.end('\n');
      const killTimer=setTimeout(() => child.kill('SIGKILL'),5_000);
      try {await closed;} finally {clearTimeout(killTimer);}
    }
    assert.equal(await fs.readFile(ownerFile, 'utf8'), original);
  });
});

test('Windows config replacement preserves a restrictive DACL in a broad parent; backups and new files are user-only', windowsOnly, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'profile [literal] ü.json');
  const fresh = path.join(root, 'new [literal] ü.json');
  await fs.writeFile(file, '{"token":"fixture-secret"}');
  windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
    $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');
    $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;
    $parent=[Security.AccessControl.DirectorySecurity]::new();
    $parent.SetAccessRuleProtection($true,$false);
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
    [IO.Directory]::SetAccessControl($files[0],$parent);
    $config=[Security.AccessControl.FileSecurity]::new();
    $config.SetAccessRuleProtection($true,$false);
    $config.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));
    $config.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));
    [IO.File]::SetAccessControl($files[1],$config);
  `, {CLIVOXA_TEST_ROOT: root, CLIVOXA_TEST_FILE: file});
  const before = await readSnapshot(file);
  assert.ok(before.windowsDacl?.startsWith('D:P'));
  let tx;
  try {
    tx = await applyChanges([
      {snapshot: before, text: '{"token":"fixture-secret","installed":true}'},
      {snapshot: await readSnapshot(fresh), text: '{"new-token":"fixture-secret"}'},
    ]);
  } catch (error) {
    // Synthetic descriptors are safe diagnostic evidence if native Windows
    // normalizes a supplied descriptor differently during file creation.
    const probe = path.join(root, 'empty permission probe');
    try { await createWindowsPrivateFile(probe, before.windowsDacl); } catch { /* Compare the created descriptor below. */ }
    assert.equal(await readWindowsDacl(probe), before.windowsDacl, error.message);
    throw error;
  }
  assert.equal((await readSnapshot(file)).windowsDacl, before.windowsDacl);
  for (const privateFile of [tx.backups[0].backupFile, fresh]) {
    const result = windowsFixture(`
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $security=[IO.File]::GetAccessControl($files[0]);
      $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
      if (!$security.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].IsInherited) {throw 'File is not user-only';}
      [Console]::Write('private');
    `, {CLIVOXA_TEST_FILE: privateFile});
    assert.equal(result, 'private');
  }
  await tx.rollback();
  assert.equal((await readSnapshot(file)).windowsDacl, before.windowsDacl);
  assert.equal(await fs.readFile(file, 'utf8'), '{"token":"fixture-secret"}');
});

test('Windows DACL edits invalidate snapshots even when configuration bytes are unchanged', windowsOnly, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{}');
  const snapshot = await readSnapshot(file);
  windowsFixture(`
    $security=[IO.File]::GetAccessControl($files[0]);
    $security.SetAccessRuleProtection($true,$true);
    [IO.File]::SetAccessControl($files[0],$security);
  `, {CLIVOXA_TEST_FILE: file});
  assert.notEqual((await readSnapshot(file)).windowsDacl, snapshot.windowsDacl);
  await assert.rejects(applyChanges([{snapshot, text: '{"changed":true}'}]), {code: 'CONFIG_CHANGED'});
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
});

test('Windows atomic replacement and rollback preserve an unprotected profile DACL with creator-owner inheritance', windowsOnly, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'inherited profile.json');
  await fs.writeFile(file, '{"original":true}');
  const originalDacl = windowsFixture(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $creator=[Security.Principal.SecurityIdentifier]::new('S-1-3-0');
    $flags=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;
    $parent=[Security.AccessControl.DirectorySecurity]::new();
    $parent.SetAccessRuleProtection($true,$false);
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($creator,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::InheritOnly,[Security.AccessControl.AccessControlType]::Allow));
    [IO.Directory]::SetAccessControl($files[0],$parent);
    $security=[IO.File]::GetAccessControl($files[1]);
    if ($security.AreAccessRulesProtected) {throw 'Fixture must use inherited profile permissions';}
    [Console]::Write($security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access));
  `, {CLIVOXA_TEST_ROOT:root, CLIVOXA_TEST_FILE:file});
  const before = await readSnapshot(file);
  const tx = await applyChanges([{snapshot:before, text:'{"installed":true}'}]);
  const rawDacl = () => windowsFixture(`[Console]::Write([IO.File]::GetAccessControl($files[0]).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access));`, {CLIVOXA_TEST_FILE:file});
  assert.equal(rawDacl(), originalDacl);
  assert.equal((await readSnapshot(file)).windowsDacl, before.windowsDacl);
  assert.equal(await fs.readFile(file, 'utf8'), '{"installed":true}');
  await tx.rollback();
  assert.equal(rawDacl(), originalDacl);
  assert.equal(await fs.readFile(file, 'utf8'), '{"original":true}');
});

test('Windows refuses configuration changes when native permission inspection is unavailable', windowsOnly, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{"token":"fixture-secret"}');
  const snapshot = await readSnapshot(file);
  const systemRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(root, 'no-windows-installation');
  try {
    await assert.rejects(applyChanges([{snapshot, text: '{}'}]), error => error.code === 'CONFIG_ACL_UNAVAILABLE' && !error.message.includes('fixture-secret'));
    assert.equal(await fs.readFile(file, 'utf8'), '{"token":"fixture-secret"}');
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
});
