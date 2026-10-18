import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsPowerShell } from '../system/platform/index.js';

/** A running Claude Desktop instance and the package family whose profile it reads. */
export interface RunningDesktop { kind: 'msix' | 'classic' | 'macos'; family?: string }

// Package full name: Name_Version_Arch_ResourceId_PublisherHash. Both the direct
// MSIX (Claude_<hash>) and the Store package (AnthropicPBC.Claude_<hash>) qualify.
const DESKTOP_NAME = /^(?:AnthropicPBC\.)?Claude$/i;
const MSIX_EXE = /\\WindowsApps\\([^\\_]+)_[^\\_]*_[^\\_]*_[^\\_]*_([a-z0-9]{13})\\(?:[^\\]+\\)*claude\.exe$/i;
const CLASSIC_EXE = /\\AnthropicClaude\\(?:[^\\]+\\)*claude\.exe$/i;
const MAC_EXE = /\/Claude\.app\/Contents\/MacOS\/Claude$/;

export function classifyDesktopProcess(executable: string, platform: NodeJS.Platform = process.platform): RunningDesktop | null {
  if (platform === 'darwin') return MAC_EXE.test(executable) ? { kind: 'macos' } : null;
  if (platform !== 'win32') return null;
  const msix = MSIX_EXE.exec(executable);
  if (msix) return DESKTOP_NAME.test(msix[1]!) ? { kind: 'msix', family: `${msix[1]}_${msix[2]!.toLowerCase()}` } : null;
  // Claude Code's own claude.exe lives elsewhere and is not the Desktop app.
  return CLASSIC_EXE.test(executable) ? { kind: 'classic' } : null;
}

function list(command: string, args: string[]): Promise<string[] | null> {
  return new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)));
  });
}

/** null means the process table could not be inspected; callers must not treat it as "not running". */
export async function runningDesktops(platform: NodeJS.Platform = process.platform): Promise<RunningDesktop[] | null> {
  let executables: string[] | null;
  if (platform === 'win32') {
    const powershell = windowsPowerShell();
    if (!powershell) return null;
    const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { $_.ExecutablePath }";
    executables = await list(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  } else if (platform === 'darwin') {
    executables = await list('/bin/ps', ['-axo', 'comm=']);
  } else return [];
  if (executables === null) return null;
  return executables.map(item => classifyDesktopProcess(item, platform)).filter((item): item is RunningDesktop => item !== null);
}

const within = (file: string, directory: string): boolean => {
  const relative = path.win32.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.win32.isAbsolute(relative);
};

/**
 * Desktop loads claude_desktop_config.json once and later rewrites the whole
 * file from memory. An instance reading this profile would erase our entry.
 */
export function desktopUsesProfile(file: string, running: readonly RunningDesktop[], env: { local?: string; roaming?: string },
  platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): boolean {
  if (platform === 'darwin') return running.some(item => item.kind === 'macos');
  if (platform !== 'win32') return false;
  return running.some(item => {
    if (item.kind === 'classic') return env.roaming !== undefined && within(file, path.win32.join(env.roaming, 'Claude'));
    if (item.kind !== 'msix' || !env.local) return false;
    const profile = path.win32.join(env.local, 'Packages', item.family!, 'LocalCache', 'Roaming', 'Claude');
    if (within(file, path.win32.join(env.local, 'Packages', item.family!))) return true;
    if (within(file, path.win32.join(env.local, 'Claude-Data', item.family!.toLowerCase()))) return true;
    // A package profile without its own config file reads the roaming file through the merged view.
    return env.roaming !== undefined && within(file, path.win32.join(env.roaming, 'Claude'))
      && exists(profile) && !exists(path.win32.join(profile, 'claude_desktop_config.json'));
  });
}

/**
 * Processes started by a packaged app (for example a terminal inside Claude
 * Desktop) see AppData through MSIX write virtualization. Files written there
 * land in that package's LocalCache and are invisible to every other host.
 * Returns the package family when this process is virtualized.
 */
export async function windowsPackageContainer(local: string): Promise<string | null> {
  const name = `.clivoxa-container-probe-${randomUUID()}`;
  const probe = path.win32.join(local, name);
  try { await fs.mkdir(probe); } catch { return null; }
  try {
    const packages = path.win32.join(local, 'Packages');
    let families: string[];
    try { families = await fs.readdir(packages); } catch { return null; }
    for (const family of families) {
      try { await fs.access(path.win32.join(packages, family, 'LocalCache', 'Local', name)); return family; } catch { /* not this package */ }
    }
    return null;
  } finally {
    await fs.rm(probe, { recursive: true, force: true }).catch(() => undefined);
  }
}
