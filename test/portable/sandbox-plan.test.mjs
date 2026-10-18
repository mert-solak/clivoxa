import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {loadConfig} from '../../dist/config/config.js';
import {decideCodexSandbox} from '../../dist/providers/codex/sandbox-plan.js';

const cfg = loadConfig({HOME: os.tmpdir()});
const request = (access, extra = {}) => ({access, workdir: os.tmpdir(), git_write: false, network: false, ...extra});

// Callers and skills branch on error_kind; a read job must not be reported as a refused write.
test('an unverified sandbox names the profile that is missing: read or write', () => {
  assert.equal(decideCodexSandbox(cfg, request('read'), null).kind, 'codex_profile_unverified');
  assert.equal(decideCodexSandbox(cfg, request('write'), null).kind, 'codex_write_unverified');
  assert.equal('error' in decideCodexSandbox(cfg, request('read', {workdir: null}), null), false, 'no files, no profile needed');
});
