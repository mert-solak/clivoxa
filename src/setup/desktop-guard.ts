import path from 'node:path';
import type { SetupHost } from './host-config.js';
import { desktopUsesProfile, runningDesktops, windowsPackageContainer, type RunningDesktop } from './desktop-processes.js';
import { addSkip, type SkippedHost } from './report.js';
import { envValue } from '../system/platform/index.js';

/** An absolute directory named by an environment variable (names are case-insensitive on Windows). */
export function environmentDirectory(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = envValue(env, name);
  return value && path.isAbsolute(value) ? path.normalize(value) : undefined;
}

export async function refuseInsidePackage(local: string | undefined): Promise<void> {
  if (process.platform !== 'win32' || !local) return;
  const family = await windowsPackageContainer(local);
  if (family) throw new Error(`Bu terminal ${family} uygulamasının içinde çalışıyor; Windows buradan yapılan kurulumu diğer uygulamalardan gizler. Başlat menüsünden normal bir PowerShell açıp komutu orada çalıştırın.`);
}

const DESKTOP_WAIT_MS = 10 * 60_000;


/**
 * A running Desktop rewrites claude_desktop_config.json from its in-memory copy,
 * silently erasing entries written meanwhile, and only reads the file at start.
 * Interactive runs wait for the user to quit it; otherwise those profiles are skipped.
 */
export async function closedDesktopProfiles(hosts: SetupHost[], dirs: { local?: string; roaming?: string }, wait: boolean,
  progress: (message: string) => void, skipped: SkippedHost[]): Promise<SetupHost[]> {
  if (!hosts.some(host => host.id === 'claude-desktop')) return hosts;
  const busy = (running: RunningDesktop[]): SetupHost[] => hosts.filter(host => host.id === 'claude-desktop'
    && desktopUsesProfile(host.file, running, dirs));
  let running = await runningDesktops();
  if (running === null) {
    progress("Uyarı: Claude Desktop'ın açık olup olmadığı anlaşılamadı; açıksa kapatılmalı.");
    return hosts;
  }
  if (wait && busy(running).length) {
    progress("Claude Desktop'ın kapatılması bekleniyor...");
    const deadline = Date.now() + DESKTOP_WAIT_MS;
    while (busy(running ?? []).length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      running = await runningDesktops();
      if (running === null) {
        progress("Uyarı: Claude Desktop'ın açık olup olmadığı anlaşılamadı; açıksa kapatılmalı.");
        return hosts;
      }
    }
    if (!busy(running ?? []).length) progress('Claude Desktop kapatıldı.');
  }
  const blocked = busy(running ?? []);
  if (blocked.length) addSkip(skipped, { host: 'Claude Desktop', reason: 'uygulama açıktı', fix: ['Claude Desktop kapatılmalı.'] });
  return hosts.filter(host => !blocked.includes(host));
}
