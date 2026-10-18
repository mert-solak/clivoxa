import path from 'node:path';
import { loadConfig, type Config } from '../config/config.js';
import { buildPath } from '../providers/child-env.js';
import { cheapGuards } from '../security/guards.js';
import { powershellLanguageMode } from '../system/platform/index.js';
import { msg } from '../shared/messages.js';
import { cliScript, packageRoot } from '../system/entrypoints.js';
import { VERSION } from '../shared/version.js';
import { discoverHosts, renderHostConfig, readHostLaunch, entryFingerprint, isHostEnabled, HOST_NAMES, type SetupHost } from './host-config.js';
import { prepareRuntime, runtimeBaseDir } from './installed-runtime.js';
import { readSnapshot, applyChanges, withSetupLock } from './config-transaction.js';
import { backupDir } from './backups.js';
import { cliVersion, unsupportedFloor, verificationEnvironment, verifyHost, type Verification, type ProviderStatus } from './verify-host.js';
import { terminalStyle } from './terminal-style.js';
import type { SetupOptions } from './options.js';
import { type Installation, readInstallation } from './installation.js';
import { environmentDirectory, refuseInsidePackage, closedDesktopProfiles } from './desktop-guard.js';
import { type HostResult, type SetupReport, type SkippedHost, addSkip, hostNames, skipSummary } from './report.js';

function managedEnvironment(cfg: Config, command: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const ceiling = source.CLIVOXA_MAX_ACCESS;
  if (ceiling && ceiling !== 'read' && ceiling !== 'write') throw new Error('CLIVOXA_MAX_ACCESS must be read or write.');
  const env: Record<string, string> = {
    NODE_BIN: command, CLIVOXA_MAX_ACCESS: ceiling || 'write', CLIVOXA_USER_PATH: buildPath(cfg, null),
    CODEX_HOME: cfg.codexHome,
  };
  for (const [key, value] of Object.entries({ CODEX_BIN: cfg.bins.codex, CLAUDE_BIN: cfg.bins.claude,
    CODEX_JS: cfg.bins.codexJs, CODEX_PATH_DIR: cfg.bins.codexPathDir, GIT_BIN: cfg.bins.git })) {
    if (value) env[key] = value;
  }
  // Persist an explicitly selected state directory, not arbitrary terminal env or credentials.
  if (source.CLIVOXA_HOME) env.CLIVOXA_HOME = cfg.home;
  if (source.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
  return env;
}

/**
 * Setup's permission helper and the server's ancestry check need Windows PowerShell's FullLanguage mode.
 * Under WDAC/AppLocker's ConstrainedLanguage they fail; refuse before anything changes, and say why.
 */
export function refuseConstrainedPowerShell(languageMode: () => string | null = powershellLanguageMode): void {
  const mode = languageMode();
  if (mode && mode !== 'FullLanguage') throw new Error(msg('powershell_language_mode', { mode }));
}

function selectedHost(host: SetupHost, selected: SetupOptions['selected']): boolean {
  return selected === 'both' || host.id === selected || (selected === 'claude' && host.role === 'codex');
}

export async function setup(options: SetupOptions, cfg = loadConfig(), source: NodeJS.ProcessEnv = process.env): Promise<SetupReport> {
  const shown = new Set<string>();
  // The Desktop check runs twice; a repeated warning is shown once, a new one always.
  const progress = (message: string): void => {
    if (options.json || shown.has(message)) return;
    shown.add(message);
    console.error(message);
  };
  const style = terminalStyle(process.stderr);
  const guard = cheapGuards(cfg, source);
  if (guard) throw new Error(`Kurulum bu alt ajan/sandbox içinde çalıştırılamaz: ${guard}`);
  refuseConstrainedPowerShell();
  const windowsDirs = {
    local: environmentDirectory(source, 'LOCALAPPDATA'), roaming: environmentDirectory(source, 'APPDATA'),
  };
  await refuseInsidePackage(windowsDirs.local);
  const discovered = discoverHosts({ home: cfg.cliHome, env: source, bins: cfg.bins }).filter(host => selectedHost(host, options.selected));
  if (!discovered.length) throw new Error('Claude Code, Claude Desktop veya Codex bulunamadı. Önce birini kurup bir kez açın.');
  progress(style.bold(`Clivoxa ${VERSION}`));
  progress(`Bulunan uygulamalar: ${hostNames(discovered).join(', ')}`);
  const skipped: SkippedHost[] = [];
  const interactive = !options.json && process.stdin.isTTY === true && process.stderr.isTTY === true;
  const hosts = await closedDesktopProfiles(discovered, windowsDirs, interactive, progress, skipped);
  if (!hosts.length) throw new Error(skipSummary(skipped));
  const installRoot = runtimeBaseDir({ home: cfg.userHome, env: source });
  return withSetupLock(installRoot, async () => {
    const manifest = await readSnapshot(path.join(installRoot, 'installation.json'));
    const previous = readInstallation(manifest.text);
    const available = hosts.filter(host => {
      const cli = host.role === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
      const skip = (reason: string, fix: string): false => {
        addSkip(skipped, { host: HOST_NAMES[host.id], reason, fix: [fix] });
        return false;
      };
      if (!cfg.bins[host.role]) return skip(`${cli} bulunamadı`, `${cli} kurulmalı ve giriş yapılmalı.`);
      // Below the supported floor every job would fail (cli_too_old): say so instead of registering it.
      const version = cliVersion(cfg, host.role, source);
      const floor = unsupportedFloor(host.role, version);
      if (floor) {
        return skip(`${cli} ${version} kurulu; en az ${floor} gerekli`,
          host.role === 'claude' ? 'Claude Code güncellenmeli: claude update' : `Codex CLI ${floor} veya üstüne güncellenmeli.`);
      }
      return true;
    });
    if (!available.length) throw new Error(skipSummary(skipped));
    // Validate every selected config before staging a runtime or changing any registration.
    const snapshots = await Promise.all(available.map(host => readSnapshot(host.file)));
    for (let i = 0; i < available.length; i++) readHostLaunch(available[i]!, snapshots[i]!.text ?? '');
    progress('Kurulum yapılıyor...');
    const runtime = options.local
      ? { root: packageRoot(), command: process.execPath, args: [cliScript()], version: VERSION }
      : await prepareRuntime({ home: cfg.userHome, env: source });
    const launchEnv = managedEnvironment(cfg, runtime.command, source);
    const initial = available.map((host, i) => {
      const snapshot = snapshots[i]!;
      const text = renderHostConfig(host, snapshot.text ?? '', {
        command: runtime.command, args: runtime.args, env: { ...launchEnv, CLIVOXA_EXPOSE: host.role, CLIVOXA_HOST: host.host },
      }, options.maxAccess);
      isHostEnabled(host, text);
      return { host, snapshot, text };
    });
    // Provider status/catalogue commands may legitimately rewrite their own
    // global settings. Finish them before taking the snapshots used for apply.
    const preflight = new Map<string, { verification: Verification; provider: ProviderStatus }>();
    for (const { host, text } of initial) {
      const launch = readHostLaunch(host, text)!;
      const verification = await verifyHost(host, launch, cfg.userHome, source, { profile: cfg.cliHome });
      const env = verificationEnvironment(launch, cfg.userHome, source, cfg.cliHome);
      const provider: ProviderStatus = { version: cliVersion(loadConfig(env), host.role, env) };
      preflight.set(host.file, { verification, provider });
    }
    // Verification can take minutes; Desktop may have been reopened meanwhile.
    const stillClosed = new Set((await closedDesktopProfiles(initial.map(item => item.host), windowsDirs, false, progress, skipped))
      .map(host => host.file));
    const planned = await Promise.all(initial.filter(item => stillClosed.has(item.host.file)).map(async ({ host, snapshot: original, text }) => {
      const snapshot = await readSnapshot(host.file);
      if (entryFingerprint(host, snapshot.text ?? '') !== entryFingerprint(host, original.text ?? '')) {
        throw new Error(`${host.label}: Clivoxa kaydı denetim sırasında değişti; setup komutunu yeniden çalıştırın.`);
      }
      const updated = renderHostConfig(host, snapshot.text ?? '', readHostLaunch(host, text)!, options.maxAccess);
      return { host, snapshot, text: updated };
    }));
    const replaced = new Set(planned.map(item => item.host.file));
    const next: Installation = { schema: 1, version: runtime.version, runtime: runtime.root,
      hosts: [...(previous?.hosts ?? []).filter(item => !replaced.has(item.host.file)),
        ...planned.map(({ host, text }) => ({ host, fingerprint: entryFingerprint(host, text)! }))] };
    const transaction = await applyChanges([
      ...planned.map(({ snapshot, text }) => ({ snapshot, text })),
      { snapshot: manifest, text: JSON.stringify(next, null, 2) + '\n' },
    ], { backupDir: backupDir(cfg) });
    const results: HostResult[] = [];
    try {
      for (const { host, snapshot, text } of planned) {
        const saved = await readSnapshot(host.file);
        if (saved.text !== text) throw new Error(`${host.label}: yapılandırma kurulum sırasında değişti.`);
        const launch = readHostLaunch(host, saved.text)!;
        await verifyHost(host, launch, cfg.userHome, source, { catalogue: false, profile: cfg.cliHome });
        const { verification, provider } = preflight.get(host.file)!;
        const enabled = isHostEnabled(host, saved.text);
        results.push({ id: host.id, label: host.label, file: host.file, changed: snapshot.text !== text,
          ...verification, provider, enabled, hostConnection: enabled ? 'restart-required' : 'disabled' });
      }
      await transaction.commit();
      if (options.maxAccess) progress(style.dim(`Erişim üst sınırı: ${options.maxAccess}. Uygulamalar yeniden açılınca geçerli olur.`));
    } catch (error) {
      try { await transaction.rollback(); }
      catch { throw new Error(`Kurulum doğrulanamadı. Eşzamanlı değişen dosyaların üzerine yazılmadı; ${backupDir(cfg)} altındaki yedekleri kontrol edip setup komutunu yeniden çalıştırın.`); }
      throw error;
    }
    return { version: runtime.version, runtime: runtime.root, hosts: results, skipped,
      ready: skipped.length === 0 && results.every(item => item.enabled && item.catalogue === 'available' && item.provider.version !== null) };
  });
}
