import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ownershipGuard, windowsForeignWriter} from '../../dist/security/guards.js';
import {directorySecurity} from '../../dist/system/platform/windows.js';

const USER = 'S-1-5-21-100-200-300-1001';
const PRIVATE = `O:${USER}G:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
// What a folder created at the root of C: (or a data drive) inherits: Authenticated Users may modify it.
const DRIVE_CHILD = `O:${USER}G:${USER}D:AI(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)`;

// On Windows the state directory's owner/mode checks were no-ops: other users could plant jobs,
// locks or a sandbox verification record that turns file access on.
test('Windows DACLs: only the user, SYSTEM and Administrators may change the state directory', () => {
  assert.equal(windowsForeignWriter(PRIVATE, USER), null);
  assert.equal(windowsForeignWriter(`${PRIVATE}(A;OICI;0x1200a9;;;BU)`, USER), null, 'reading is not writing');
  assert.equal(windowsForeignWriter(`${PRIVATE}(D;OICI;FA;;;WD)`, USER), null, 'a deny entry grants nothing');
  assert.match(windowsForeignWriter(DRIVE_CHILD, USER), /AU/);
  assert.match(windowsForeignWriter(`${PRIVATE}(A;;FW;;;WD)`, USER), /WD/);
  assert.match(windowsForeignWriter(`${PRIVATE}(A;;0x2;;;S-1-5-21-100-200-300-1002)`, USER), /1002/, 'add-file alone is a write');
  assert.match(windowsForeignWriter(PRIVATE.replace(`O:${USER}`, 'O:S-1-5-21-100-200-300-1002'), USER), /sahip/);
  assert.ok(windowsForeignWriter(`O:${USER}G:${USER}D:NO_ACCESS_CONTROL`, USER), 'a null DACL lets everyone in');
  assert.ok(windowsForeignWriter(`${PRIVATE}(A;;ZZ;;;BU)`, USER), 'an unknown right counts as a write');
  assert.ok(windowsForeignWriter('garbage', USER));
});

test('Windows DACLs: a conditional entry never hides the entries after it; what cannot be read fails closed', () => {
  // A conditional ACE carries its own parentheses; the write grant after it must still be seen.
  const conditional = `${PRIVATE}(XA;;FR;;;WD;(Member_of {SID(BA)}))(A;;FW;;;S-1-5-21-100-200-300-1002)`;
  assert.match(windowsForeignWriter(conditional, USER), /1002/);
  assert.match(windowsForeignWriter(`${PRIVATE}(XA;;FW;;;WD;(Member_of {SID(BA)}))`, USER), /WD/, 'a conditional grant counts like a plain one');
  assert.ok(windowsForeignWriter(`${PRIVATE}(A;;FW;;;WD`, USER), 'an unbalanced DACL is unreadable');
  assert.ok(windowsForeignWriter(`${PRIVATE}garbage`, USER), 'trailing text is unreadable');
  assert.ok(windowsForeignWriter(`${PRIVATE}(Q;;FA;;;WD)`, USER), 'an unknown entry type counts');
  assert.equal(windowsForeignWriter(`${PRIVATE}S:AI(AU;FA;FA;;;WD)`, USER), null, 'the SACL that may follow is not a grant');
  // The built-in Administrator (RID 500) appears as LA in SDDL.
  const admin = 'S-1-5-21-100-200-300-500';
  assert.equal(windowsForeignWriter(`O:LAG:LAD:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)`, admin), null);
  assert.match(windowsForeignWriter(`O:${USER}G:${USER}D:PAI(A;OICI;FA;;;${USER})(A;;FA;;;LA)`, USER), /LA/, 'for anyone else LA is another account');
});

test('Windows: a junction inside the profile that leads elsewhere gets no exemption; CLM is named', {skip: process.platform !== 'win32' && 'Windows ACLs only'}, (t) => {
  const passwdHome = os.userInfo().homedir;
  const outside = fs.mkdtempSync(path.join(path.parse(passwdHome).root, 'clivoxa-junction-target-'));
  const link = path.join(passwdHome, `.clivoxa-junction-test-${process.pid}`);
  fs.symlinkSync(outside, link, 'junction');
  t.after(() => { fs.rmSync(link, {force: true}); fs.rmSync(outside, {recursive: true, force: true}); });
  const seen = [];
  const reading = (dir) => { seen.push(dir); return {sddl: DRIVE_CHILD, userSid: USER}; };
  // The state directory does not exist yet: only its parent junction does.
  assert.match(ownershipGuard({home: path.join(link, 'state'), passwdHome}, reading), /AU/);
  assert.equal(seen.length, 1, 'its real location was checked');
  assert.match(ownershipGuard({home: path.join(link, 'state'), passwdHome}, () => null, () => 'ConstrainedLanguage'), /ConstrainedLanguage/);
});

const windowsOnly = {skip: process.platform !== 'win32' && 'Windows ACLs only'};

test('Windows: a state directory outside the profile is checked where it would be created; inside it, no probe runs', windowsOnly, () => {
  const passwdHome = os.userInfo().homedir;
  const outside = path.join(path.parse(passwdHome).root, `clivoxa-state-test-${process.pid}`, 'state');
  const seen = [];
  const reading = (sddl) => (dir) => { seen.push(dir); return sddl === null ? null : {sddl, userSid: USER}; };
  const refusal = ownershipGuard({home: outside, passwdHome}, reading(DRIVE_CHILD));
  assert.match(refusal, /başka kullanıcılar değiştirebilir \(yazma izni: AU\)/);
  assert.ok(!refusal.includes('clivoxa-state-test'), 'no path: refusals reach the host model, and another user may name the directory');
  assert.deepEqual(seen, [path.parse(passwdHome).root], 'a missing directory inherits its nearest existing parent');
  assert.equal(ownershipGuard({home: outside, passwdHome}, reading(PRIVATE)), null);
  assert.match(ownershipGuard({home: outside, passwdHome}, reading(null)), /doğrulanamadı/, 'an unreadable DACL fails closed');
  seen.length = 0;
  assert.equal(ownershipGuard({home: path.join(passwdHome, '.clivoxa'), passwdHome}, reading(DRIVE_CHILD)), null);
  assert.deepEqual(seen, [], 'the private user profile needs no probe');
});

test('Windows: the real DACL of a private directory passes, and fails once other users may modify it', windowsOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-acl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const icacls = (...args) => {
    const r = spawnSync('icacls', [dir, ...args], {encoding: 'utf8', windowsHide: true});
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  const initial = directorySecurity(dir);
  assert.ok(initial, 'Get-Acl and the current SID are readable');
  // A fresh temp directory inherits a DACL this test does not control: start from an explicit private one.
  icacls('/inheritance:r', '/grant:r', `*${initial.userSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F');
  const before = directorySecurity(dir);
  assert.equal(windowsForeignWriter(before.sddl, before.userSid), null, before.sddl);
  icacls('/grant', '*S-1-5-11:(OI)(CI)M');
  const after = directorySecurity(dir);
  assert.match(windowsForeignWriter(after.sddl, after.userSid), /AU|S-1-5-11/, after.sddl);
});
