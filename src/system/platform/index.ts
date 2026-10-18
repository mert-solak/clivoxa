import path from 'node:path';
import * as posix from './posix.js';
import * as windows from './windows.js';

export type { Liveness } from './posix.js';

const platform = process.platform === 'win32' ? windows : posix;
/** Process control for the current OS: liveness, process trees, signals and ancestry. */
export const { probe, descendants, signalAll, isGone, ancestorCommands } = platform;
export type { DirectorySecurity } from './windows.js';
/** Owner and DACL (SDDL) of a Windows directory and the current user's SID; null elsewhere or when unreadable. */
export function directorySecurity(dir: string): windows.DirectorySecurity | null {
  return process.platform === 'win32' ? windows.directorySecurity(dir) : null;
}
/** Windows PowerShell's language mode (e.g. ConstrainedLanguage under WDAC/AppLocker); null elsewhere or when unreadable. */
export function powershellLanguageMode(): string | null {
  return process.platform === 'win32' ? windows.languageMode() : null;
}
export const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
export const pathApi = (os: NodeJS.Platform) => os === 'win32' ? path.win32 : path.posix;
export const WINDOWS_ENV_KEYS = [
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'PSModulePath', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
] as const;
/** An environment variable by name. Windows names are case-insensitive; the first spelling found wins. */
export function envValue(env: NodeJS.ProcessEnv, name: string, os: NodeJS.Platform = process.platform): string | undefined {
  if (os !== 'win32') return env[name];
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}
/** Windows PowerShell under %SystemRoot%, or null when SystemRoot is not an absolute drive path. */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return /^[A-Za-z]:[\\/]/.test(root) ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
}
export function systemEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WINDOWS_ENV_KEYS) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}
