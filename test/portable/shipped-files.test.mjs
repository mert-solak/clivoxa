import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CLAUDE_UPLOAD_LINT, lintSkill} from '../../scripts/lib/skill-zip.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const modules = (dir) => fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true}).flatMap((entry) => {
  const rel = path.join(dir, entry.name);
  return entry.isDirectory() ? modules(rel) : rel.endsWith('.mjs') ? [rel] : [];
});

// Some scripts run only on POSIX or by hand; a syntax error there would otherwise go unnoticed.
test('every script and test module parses', () => {
  const broken = [];
  for (const rel of [...modules('scripts'), ...modules('test')]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], {encoding: 'utf8', windowsHide: true});
    if (r.status !== 0) broken.push(`${rel}: ${r.stderr.split('\n').find((line) => line.includes('Error')) ?? r.stderr}`);
  }
  assert.deepEqual(broken, []);
});

test('shipped skills pass their lint; the Codex skill also fits the claude.ai upload limits', () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  assert.deepEqual(lintSkill(read('clivoxa-codex-ile-calis'), CLAUDE_UPLOAD_LINT), []);
  assert.deepEqual(lintSkill(read('clivoxa-claude-ile-calis')), []);
  assert.deepEqual(lintSkill(read('clivoxa-codex-ile-calis').replace(/\r?\n/g, '\r\n'), CLAUDE_UPLOAD_LINT), [], 'CRLF checkouts lint the same');
});
