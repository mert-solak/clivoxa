import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageRoot } from '../system/entrypoints.js';
import { envValue } from '../system/platform/index.js';

const run = promisify(execFile);
const MANIFEST = '.clivoxa-runtime.json';
const PAYLOAD = ['dist', 'scripts/lib', 'package.json', 'LICENSE'] as const;
const PACKAGE = '@mertsolak/clivoxa';

export interface RuntimeOptions {
  sourceRoot?: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  node?: string;
}

export interface InstalledRuntime {
  root: string;
  installRoot: string;
  command: string;
  args: string[];
  version: string;
}

interface PayloadFile { path: string; size: number; sha256: string }
interface RuntimeManifest { schema: 1; package: string; version: string; digest: string; files: PayloadFile[] }

function absolute(value: string, description: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${description} must be an absolute path.`);
  return path.resolve(value);
}

function inside(directory: string, target: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(directory), normalize(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Separate from job/archive state: runtime paths must remain usable by the startup guards. */
export function runtimeBaseDir(options: RuntimeOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const userHome = absolute(options.home ?? os.homedir(), 'User home');
  let data: string;
  if (platform === 'win32') data = envValue(env, 'LOCALAPPDATA', platform) || path.join(userHome, 'AppData', 'Local');
  else if (platform === 'darwin') data = path.join(userHome, 'Library', 'Application Support');
  else {
    const xdg = env.XDG_DATA_HOME;
    data = xdg && path.isAbsolute(xdg) ? xdg : path.join(userHome, '.local', 'share');
  }
  const base = path.join(absolute(data, 'Application data directory'), 'clivoxa');
  const states = [path.join(userHome, '.clivoxa'), path.join(userHome, '.kopru')];
  const configured = envValue(env, 'CLIVOXA_HOME', platform);
  if (configured) states.push(absolute(configured, 'CLIVOXA_HOME'));
  if (states.some(state => inside(state, base, platform))) throw new Error('Runtime directory must be outside Clivoxa job/archive state.');
  return base;
}

async function directory(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime directories must be real directories, not links.');
}

async function privatePath(file: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows app-data inherits the user's ACL, not Unix mode bits.
  const stat = await fs.lstat(file);
  if ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Installed runtime paths must be owned by the current user and not writable by others.');
}

async function regular(file: string): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Runtime payload must contain only regular files and directories.');
  // Compare the opened handle with lstat so a link swapped in during collection is not followed silently.
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Runtime payload changed during collection.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function collect(root: string, names: readonly string[], installed = false): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const visit = async (relative: string): Promise<void> => {
    const file = path.join(root, ...relative.split('/'));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Runtime payload must not contain symbolic links.');
    if (installed) await privatePath(file);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) {
        // Backslashes are separators on Windows. Reject nonportable names before joining.
        if (/[\\<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Runtime payload contains a nonportable file name.');
        await visit(`${relative}/${name}`);
      }
    } else result.set(relative, await regular(file));
  };
  for (const name of names) await visit(name);
  return new Map([...result].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function manifestFor(payload: Map<string, Buffer>, version: string): RuntimeManifest {
  const files = [...payload].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { schema: 1, package: PACKAGE, version, digest, files };
}

async function sameRuntime(root: string, expected: RuntimeManifest): Promise<boolean> {
  try {
    await directory(root);
    await privatePath(root);
    await privatePath(path.join(root, MANIFEST));
    const actual = JSON.parse((await regular(path.join(root, MANIFEST))).toString('utf8')) as unknown;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    const names = (await fs.readdir(root)).filter(name => name !== MANIFEST).sort();
    const payload = await collect(root, names, true);
    return JSON.stringify(manifestFor(payload, expected.version)) === JSON.stringify(expected);
  } catch { return false; }
}

function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  // Local configuration must not inject code into the installer self-check.
  for (const key of Object.keys(result)) if (['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) delete result[key];
  return result;
}

async function checkVersion(command: string, root: string, expected: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const result = await run(command, [path.join(root, 'dist', 'clivoxa.mjs'), '--version'], {
      cwd: root, env, windowsHide: true, timeout: 15_000, maxBuffer: 32_768,
    });
    if (result.stdout.trim() !== expected) throw new Error('version mismatch');
  } catch { throw new Error('Installed runtime self-check failed; no host configuration was changed.'); }
}

/** Copy this exact npm/Git payload, never a guessed registry package or npx cache path. */
export async function prepareRuntime(options: RuntimeOptions = {}): Promise<InstalledRuntime> {
  const env = options.env ?? process.env;
  const checkEnv = cleanEnvironment(env);
  const platform = options.platform ?? process.platform;
  const userHome = absolute(options.home ?? os.homedir(), 'User home');
  const source = await fs.realpath(absolute(options.sourceRoot ?? packageRoot(), 'Package root'));
  await directory(source);
  const command = await fs.realpath(absolute(options.node ?? process.execPath, 'Node executable'));
  if (!(await fs.stat(command)).isFile()) throw new Error('Node executable must be a regular file.');
  try {
    const result = await run(command, ['--version'], { env: checkEnv, windowsHide: true, timeout: 15_000, maxBuffer: 32_768 });
    if (!/^v(\d+)\./.test(result.stdout.trim()) || Number(/^v(\d+)\./.exec(result.stdout.trim())?.[1]) < 22) throw new Error('old Node');
  } catch { throw new Error('A working Node.js 22 or newer executable is required.'); }

  // Verify intermediate directories too; scripts/lib must not traverse a scripts symlink.
  await directory(path.join(source, 'scripts'));
  const payload = await collect(source, PAYLOAD);
  let metadata: { name?: unknown; version?: unknown };
  try { metadata = JSON.parse(payload.get('package.json')!.toString('utf8')) as typeof metadata; }
  catch { throw new Error('Runtime package metadata is invalid.'); }
  if (metadata?.name !== PACKAGE || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error('Runtime package name or version is invalid.');
  }
  for (const required of ['dist/clivoxa.mjs', 'dist/THIRD-PARTY-NOTICES.txt', 'scripts/lib/verify-claude.mjs', 'scripts/lib/verify-sandbox.mjs', 'LICENSE']) {
    if (!payload.get(required)?.length) throw new Error(`Runtime package is missing ${required}.`);
  }
  const manifest = manifestFor(payload, metadata.version);
  const base = runtimeBaseDir(options);
  await fs.mkdir(path.dirname(base), { recursive: true });
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await directory(base);
  await privatePath(base);
  const installRoot = await fs.realpath(base);
  // Resolve existing parents, including redirected app-data paths, before writing a payload.
  for (const state of [path.join(userHome, '.clivoxa'), path.join(userHome, '.kopru'), envValue(env, 'CLIVOXA_HOME', platform)].filter((value): value is string => !!value)) {
    const realState = await fs.realpath(state).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return path.resolve(state); throw error; });
    if (inside(realState, installRoot, platform)) throw new Error('Runtime directory resolves inside Clivoxa job/archive state.');
  }
  const runtimes = path.join(installRoot, 'runtime');
  await fs.mkdir(runtimes, { recursive: true, mode: 0o700 });
  await directory(runtimes);
  await privatePath(runtimes);
  const prefix = `${metadata.version}-${manifest.digest}-`;
  for (const name of (await fs.readdir(runtimes)).filter(name => name.startsWith(prefix)).sort()) {
    const root = path.join(runtimes, name);
    if (!await sameRuntime(root, manifest)) continue;
    await checkVersion(command, root, metadata.version, checkEnv);
    return { root, installRoot, command, args: [path.join(root, 'dist', 'clivoxa.mjs')], version: metadata.version };
  }

  const staging = await fs.mkdtemp(path.join(runtimes, '.stage-'));
  try {
    for (const [relative, bytes] of payload) {
      const destination = path.join(staging, ...relative.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    await fs.writeFile(path.join(staging, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!await sameRuntime(staging, manifest)) throw new Error('Staged runtime integrity check failed.');
    await checkVersion(command, staging, metadata.version, checkEnv);
    // Never replace an earlier installation: it may still have running jobs.
    const root = path.join(runtimes, `${prefix}${randomUUID()}`);
    await fs.rename(staging, root);
    return { root, installRoot, command, args: [path.join(root, 'dist', 'clivoxa.mjs')], version: metadata.version };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
