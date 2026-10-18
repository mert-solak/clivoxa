import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyHost} from '../../dist/setup/verify-host.js';

const BUNDLE = fileURLToPath(new URL('../../dist/clivoxa.mjs', import.meta.url));

// A server that refuses to offer tools says why on stderr; setup must pass that reason on.
test('a refused verification names the server refusal instead of an unexplained failure', {timeout: 60_000}, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-verify-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const host = {id: 'claude-code', label: 'Claude Code', file: path.join(home, '.claude.json'), role: 'codex', host: 'claude-code'};
  const launch = {command: process.execPath, args: [BUNDLE], env: {CLIVOXA_HOME: path.join(home, '.clivoxa')}}; // no CLIVOXA_EXPOSE
  await assert.rejects(verifyHost(host, launch, home, {}), (error) => {
    assert.match(error.message, /^Claude Code: Clivoxa test sırasında başlatılamadı \(sunucu araç sunmayı reddetti: CLIVOXA_EXPOSE/);
    assert.match(error.message, /hiçbir kayıt değiştirilmedi/);
    return true;
  });
});
