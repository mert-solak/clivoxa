import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {browserProfileDirs} from '../../dist/security/policy.js';
import {codexReadDeny} from '../../dist/providers/codex/argv.js';
import {claudeReadDeny} from '../../dist/providers/claude/argv.js';

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-secrets-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  return {home, cfg: loadConfig({HOME: home, USERPROFILE: home, PATH: ''})};
}
const covered = (denied, file) => denied.some((d) => file === d || file.startsWith(d + path.sep));
const claudeCovers = (rules, file) => {
  const slash = file.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => '/' + d.toLowerCase() + '/');
  return rules.some((r) => {
    const m = /^Read\(\/(.+?)(\/\*\*)?\)$/.exec(r);
    return m && (slash === m[1] || (m[2] && slash.startsWith(m[1] + '/')));
  });
};

// Browser profiles hold cookies and saved logins; the read deny lists only named some of them.
test('browser profiles are read-denied for both sub-agents on every platform', (t) => {
  assert.ok(browserProfileDirs('linux').includes('.mozilla'));
  for (const rel of ['.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', 'snap/firefox']) assert.ok(browserProfileDirs('linux').includes(rel), rel);
  for (const rel of ['Library/Application Support/Microsoft Edge', 'Library/Application Support/BraveSoftware', 'Library/Safari']) assert.ok(browserProfileDirs('darwin').includes(rel), rel);
  assert.ok(browserProfileDirs('win32').includes('AppData/Local/BraveSoftware'));
  // Firefox 147+ on Linux, other Chrome channels, and Vivaldi/Opera/Arc outside Linux.
  assert.ok(browserProfileDirs('linux').includes('.config/mozilla'));
  for (const rel of ['Library/Application Support/Google', 'Library/Application Support/Vivaldi', 'Library/Application Support/com.operasoftware.Opera', 'Library/Application Support/Arc']) assert.ok(browserProfileDirs('darwin').includes(rel), rel);
  for (const rel of ['AppData/Local/Google', 'AppData/Local/Vivaldi', 'AppData/Roaming/Opera Software']) assert.ok(browserProfileDirs('win32').includes(rel), rel);
  const {home, cfg} = fixture(t);
  const codex = codexReadDeny(cfg);
  const claude = claudeReadDeny(cfg);
  for (const rel of browserProfileDirs(process.platform)) {
    const profile = path.join(home, rel, 'Default', 'Cookies');
    assert.ok(covered(codex, profile), `Codex: ${rel}`);
    assert.ok(claudeCovers(claude, profile), `Claude: ${rel}`);
  }
});
