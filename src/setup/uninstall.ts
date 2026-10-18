import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { entryFingerprint, removeHostEntry, HOST_NAMES } from './host-config.js';
import { runtimeBaseDir } from './installed-runtime.js';
import { readSnapshot, applyChanges, withSetupLock } from './config-transaction.js';
import { backupDir } from './backups.js';
import { terminalStyle } from './terminal-style.js';
import { type OwnedHost, readInstallation } from './installation.js';
import { environmentDirectory, refuseInsidePackage, closedDesktopProfiles } from './desktop-guard.js';
import type { SkippedHost } from './report.js';

/** Remove only unchanged registrations recorded by this installer. Keep archives and runtimes for running jobs. */
export async function uninstall(cfg = loadConfig(), source: NodeJS.ProcessEnv = process.env): Promise<void> {
  await refuseInsidePackage(environmentDirectory(source, 'LOCALAPPDATA'));
  const style = terminalStyle(process.stdout);
  const installRoot = runtimeBaseDir({ home: cfg.userHome, env: source });
  await withSetupLock(installRoot, async () => {
    const manifest = await readSnapshot(path.join(installRoot, 'installation.json'));
    const previous = readInstallation(manifest.text);
    if (!previous) { console.log('Clivoxa kurulu değil.'); return; }
    const retained: OwnedHost[] = [];
    const changes = [];
    const notes: string[] = [];
    const dirs = { local: environmentDirectory(source, 'LOCALAPPDATA'), roaming: environmentDirectory(source, 'APPDATA') };
    const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
    // A running Desktop would write its in-memory copy back and restore the entry.
    const skipped: SkippedHost[] = [];
    const removable = new Set(await closedDesktopProfiles(previous.hosts.map(item => item.host), dirs, interactive,
      message => console.error(message), skipped));
    for (const item of skipped) notes.push(`${item.host}: ${item.reason}; kayıt bırakıldı. ${item.fix.join(" ")}`.trim());
    for (const item of previous.hosts) {
      if (!removable.has(item.host)) { retained.push(item); continue; }
      const snapshot = await readSnapshot(item.host.file);
      if (snapshot.text === null) continue;
      if (entryFingerprint(item.host, snapshot.text) !== item.fingerprint) {
        retained.push(item);
        const note = `${HOST_NAMES[item.host.id]}: kayıt sonradan değiştirildiği için bırakıldı.`;
        if (!notes.includes(note)) notes.push(note);
        continue;
      }
      changes.push({ snapshot, text: removeHostEntry(item.host, snapshot.text) });
    }
    changes.push({ snapshot: manifest, text: JSON.stringify({ ...previous, hosts: retained }, null, 2) + '\n' });
    const transaction = await applyChanges(changes, { backupDir: backupDir(cfg) });
    await transaction.commit();
    console.log(style.bold(notes.length ? 'Clivoxa kısmen kaldırıldı.' : 'Clivoxa kaldırıldı.'));
    if (notes.length) {
      console.log('\nBırakılan kayıtlar:');
      for (const note of notes) console.log(`  - ${note}`);
    }
  });
}
