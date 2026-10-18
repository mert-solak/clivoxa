import fs from 'node:fs';
import path from 'node:path';
import { expandHome, type Access, type Config } from '../config/config.js';
import { msg } from '../shared/messages.js';
import { caseFold, realpathOr, within } from '../system/paths.js';
import { runHardenedGit } from './git.js';
import { CLIVOXA_PRIVATE_DIRS, CLIVOXA_PRIVATE_FILES, METADATA_DIRS, SECRET_DIRS_REL, SECRET_FILES_REL } from './policy.js';

/** Extra roots that can never be a workdir (relative to home), besides SECRET_DIRS_REL. */
const FORBIDDEN_HOME_REL = ['Library', 'AppData', '.Trash', '.local', '.npm', '.nvm', '.cargo', '.rustup', '.pyenv', '.config', '.cache'];
const FORBIDDEN_ABS = ['/', '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/tmp', '/opt', '/Volumes', '/dev', '/cores', '/proc', '/sys', '/boot', '/root', '/home', '/Users'];
/** Path components that make a write workdir a metadata directory. */
const METADATA_PARTS = new Set(METADATA_DIRS);
/** ~/Library subtrees that CLIVOXA_EXTRA_ROOTS may re-open. */
const LIFTABLE_LIBRARY = ['Library/Mobile Documents', 'Library/CloudStorage'];

export interface WorkdirInfo {
  real: string;
  gitTop: string | null;
  gitDir: string | null;
  gitCommonDir: string | null;
}

export class WorkdirError extends Error {}

function hardenedGit(cfg: Config, cwd: string, args: string[]): string | null {
  const r = runHardenedGit(cfg, cwd, args);
  return r.ok ? r.out : null;
}

export function gitInfo(cfg: Config, real: string): Pick<WorkdirInfo, 'gitTop' | 'gitDir' | 'gitCommonDir'> {
  const out = hardenedGit(cfg, real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (!out) return { gitTop: null, gitDir: null, gitCommonDir: null };
  const [top, dir, common] = out.split('\n').map((s) => s.trim());
  return { gitTop: top || null, gitDir: dir || null, gitCommonDir: common || null };
}

/** Validate a workdir parameter. Throws WorkdirError with a Turkish message. */
export function validateWorkdir(cfg: Config, input: string, access: Access, installDir: string): WorkdirInfo {
  if (typeof input !== 'string' || /[\0-\x1f]/.test(input)) throw new WorkdirError(msg('workdir_invalid_chars'));
  let p = expandHome(input.trim(), cfg.userHome);
  if (!path.isAbsolute(p)) throw new WorkdirError(msg('workdir_not_absolute'));
  p = path.normalize(p);
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    throw new WorkdirError(msg('workdir_missing', { path: p }));
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new WorkdirError(msg('workdir_missing', { path: p }));
  }
  if (!st.isDirectory()) throw new WorkdirError(msg('workdir_not_dir', { path: p }));
  try {
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK | (access === 'write' ? fs.constants.W_OK : 0));
  } catch {
    throw new WorkdirError(msg('workdir_no_access', { path: p }));
  }
  try {
    fs.readdirSync(real);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw new WorkdirError(msg('workdir_tcc', { path: p }));
    throw new WorkdirError(msg('workdir_no_access', { path: p }));
  }
  const homeReal = realpathOr(cfg.userHome);
  const passwdHomeReal = realpathOr(cfg.passwdHome);
  if (caseFold(real) === caseFold(path.parse(real).root) || [homeReal, passwdHomeReal].some((root) => caseFold(root) === caseFold(real))) {
    throw new WorkdirError(msg('workdir_forbidden', { root: real }));
  }
  if (process.platform === 'win32') {
    const systemRoots = [process.env.SystemRoot, process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root);
    if (systemRoots.some((root) => within(real, root))) throw new WorkdirError(msg('workdir_forbidden', { root: real }));
  }
  const extra = cfg.extraRoots.map(realpathOr);
  const inExtra = extra.some((r) => within(real, r));
  const inHome = (within(real, homeReal) && caseFold(real) !== caseFold(homeReal)) || (within(real, passwdHomeReal) && caseFold(real) !== caseFold(passwdHomeReal));
  if (!inHome && !inExtra) {
    if (FORBIDDEN_ABS.some((f) => caseFold(real) === caseFold(f))) throw new WorkdirError(msg('workdir_forbidden', { root: real }));
    throw new WorkdirError(msg('workdir_outside_home'));
  }
  for (const h of unique([homeReal, passwdHomeReal])) {
    for (const rel of [...SECRET_DIRS_REL, ...SECRET_FILES_REL]) {
      const root = path.join(h, rel);
      if (within(real, root) || within(real, realpathOr(root))) throw new WorkdirError(msg('workdir_forbidden', { root: `~/${rel}` }));
    }
    for (const rel of FORBIDDEN_HOME_REL) {
      const root = path.join(h, rel);
      if (!within(real, root)) continue;
      const lifted = rel === 'Library' && LIFTABLE_LIBRARY.some((l) => within(real, path.join(h, l)) && extra.some((x) => within(real, x)));
      if (!lifted) throw new WorkdirError(msg('workdir_forbidden', { root: `~/${rel}` }));
    }
  }
  const clivoxaReal = realpathOr(cfg.home);
  for (const root of [...cfg.secretDirs, ...cfg.secretFiles]) {
    if (within(real, root) || within(real, realpathOr(root))) throw new WorkdirError(msg('workdir_forbidden', { root }));
  }
  if (within(real, clivoxaReal)) throw new WorkdirError(msg('workdir_forbidden', { root: '~/.clivoxa' }));
  // A write workdir must not contain the archive (sandbox records, locks and jobs live there).
  if (access === 'write' && within(clivoxaReal, real)) throw new WorkdirError(msg('workdir_forbidden', { root: `${real} (CLIVOXA_HOME içeriyor)` }));
  if (access === 'write') {
    const inst = realpathOr(installDir);
    if (within(real, inst) || within(inst, real)) throw new WorkdirError(msg('workdir_install_dir'));
    for (const part of real.split(path.sep)) {
      if (METADATA_PARTS.has(caseFold(part))) throw new WorkdirError(msg('workdir_metadata', { part }));
    }
    if (/[*?[\]{}]/.test(real)) throw new WorkdirError(msg('workdir_glob'));
    const insideGitDir = hardenedGit(cfg, real, ['rev-parse', '--is-inside-git-dir']);
    if (insideGitDir && insideGitDir.trim() === 'true') throw new WorkdirError(msg('workdir_metadata', { part: '.git' }));
  }
  return { real, ...gitInfo(cfg, real) };
}

/**
 * Each path plus, when it exists and resolves elsewhere (symlink, junction), its real location. A
 * deny rule on the link alone would leave the target readable under its own name.
 */
export function withRealPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p);
    try {
      const real = fs.realpathSync.native(p);
      if (real !== p) out.push(real);
    } catch {
      /* missing: nothing to resolve */
    }
  }
  return unique(out);
}

/** Absolute secret paths for read-deny lists, expanded for every distinct home and real location. */
export function secretPaths(cfg: Config): { dirs: string[]; files: string[] } {
  const homes = unique([cfg.userHome, cfg.passwdHome]);
  return {
    dirs: withRealPaths([...homes.flatMap((h) => SECRET_DIRS_REL.map((r) => path.join(h, r))), ...cfg.secretDirs]),
    // A relocated Claude profile (CLAUDE_CONFIG_DIR) keeps its .claude.json inside the profile dir.
    files: withRealPaths([...homes.flatMap((h) => SECRET_FILES_REL.map((r) => path.join(h, r))), path.join(cfg.claudeConfigDir, '.claude.json'), ...cfg.secretFiles]),
  };
}

/** Clivoxa's private state in every state dir this user may have: ~/.clivoxa per home, and CLIVOXA_HOME. */
export function clivoxaPrivatePaths(cfg: Config): { dirs: string[]; files: string[] } {
  const roots = unique([...unique([cfg.userHome, cfg.passwdHome]).map((h) => path.join(h, '.clivoxa')), cfg.home]);
  return {
    dirs: roots.flatMap((root) => CLIVOXA_PRIVATE_DIRS.map((rel) => path.join(root, rel))),
    files: roots.flatMap((root) => CLIVOXA_PRIVATE_FILES.map((rel) => path.join(root, rel))),
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
