import fs from 'node:fs';
import { pathApi } from './platform/index.js';

export interface ExecutableLaunch { cmd: string; pre: string[] }
export function nodeScript(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(256);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return /^#![^\r\n]*\bnode\b/.test(buffer.subarray(0, size).toString());
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Resolve npm shims as data; never execute batch files or invoke a shell. */
export function resolveExecutable(file: string, os: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  try {
    const real = fs.realpathSync.native(file);
    if (!fs.statSync(real).isFile()) return null;
    if (os !== 'win32' || !/\.(?:cmd|bat|ps1)$/i.test(real)) return real;
    const api = pathApi(os);
    const base = api.dirname(real);
    const shim = fs.readFileSync(real, 'utf8');
    if (shim.length > 32_768) return null;
    const targets = [...shim.matchAll(/(?:%dp0%|\$basedir)[\\/]([^\r\n"']+?\.(?:exe|cjs|mjs|js))(?=["'\s])/g)];
    for (const match of targets) {
      const rel = match[1]!;
      if (rel.includes('..') || /[%$`]/.test(rel)) continue;
      // npm's JS shims probe an adjacent node.exe before referencing the actual CLI.
      // That path is the interpreter, not the program this shim exposes.
      if (api.normalize(rel).toLowerCase() === 'node.exe') continue;
      const target = api.resolve(base, rel.replace(/[\\/]/g, api.sep));
      if (!fs.existsSync(target)) continue;
      if (/\.exe$/i.test(target) || nodeScript(target)) return fs.realpathSync.native(target);
      if (/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(target)) {
        if (arch !== 'x64' && arch !== 'arm64') return null;
        const vendor = api.join(base, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`, 'bin', 'codex.exe');
        if (fs.existsSync(vendor)) return fs.realpathSync.native(vendor);
      }
    }
    return null;
  } catch { return null; }
}

export function discoverExecutable(name: string, env: NodeJS.ProcessEnv, home: string, os: NodeJS.Platform = process.platform): string | null {
  const api = pathApi(os);
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const dirs = pathValue.split(api.delimiter);
  dirs.push(api.dirname(process.execPath), api.join(home, '.local', 'bin'), api.join(home, '.npm-global', 'bin'));
  if (os === 'win32') {
    if (env.APPDATA) dirs.push(api.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(api.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    if (env.ProgramFiles && name === 'git') dirs.push(api.join(env.ProgramFiles, 'Git', 'cmd'));
  } else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  for (const dir of new Set(dirs)) {
    if (!api.isAbsolute(dir)) continue;
    if (os !== 'win32') {
      try {
        const stat = fs.statSync(dir);
        const uid = process.getuid?.();
        if (!stat.isDirectory() || (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o002) || ((stat.mode & 0o020) && !(os === 'darwin' && stat.gid === 80))) continue;
      } catch { continue; }
    }
    for (const ext of os === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const resolved = resolveExecutable(api.join(dir, name + ext), os);
      if (resolved) return resolved;
    }
  }
  return null;
}

export function executableLaunch(file: string, node: string): ExecutableLaunch {
  const resolved = resolveExecutable(file);
  if (!resolved) throw new Error(`Executable could not be resolved safely: ${file}`);
  return nodeScript(resolved) ? { cmd: node, pre: [resolved] } : { cmd: resolved, pre: [] };
}
