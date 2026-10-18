import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {probeCommand} from '../../scripts/lib/verify-sandbox.mjs';

// Codex exec_command hands the probe line to PowerShell on Windows (5.1 on a stock install) and to a POSIX shell elsewhere.
const shell = process.platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']]
  : ['/bin/sh', ['-c']];

test('the Codex sandbox probe reaches node intact through the shell exec_command runs it with', t => {
  // A space and a quote in the path; double quotes and backslashes in the program, as JSON.stringify of real paths makes them.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clivoxa probe '")));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const values = ['a b', 'q"q', "s'q", dir, path.join(dir, 'ok.txt')];
  // Hex keeps the shell's console encoding out of the comparison.
  const program = `console.log('P=' + Buffer.from(JSON.stringify(${JSON.stringify(values)})).toString('hex'));`;
  const [cmd, pre] = shell;
  const run = spawnSync(cmd, [...pre, probeCommand(process.execPath, program, dir)], {cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60_000});
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error?.message ?? ''}`);
  assert.match(run.stdout, new RegExp(`^P=${Buffer.from(JSON.stringify(values)).toString('hex')}\\r?$`, 'm'));
});
