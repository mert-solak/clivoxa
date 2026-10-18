import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config/config.js';
import { ancestorCommands, directorySecurity, powershellLanguageMode, type DirectorySecurity } from '../system/platform/index.js';
import { msg } from '../shared/messages.js';
import { realpathOr, within } from '../system/paths.js';

/**
 * Loop guards. Any hit means this server instance runs inside a consulted sub-agent (directly or
 * indirectly) and must refuse every call. Cheap checks run per call; the ps walk and the sandbox
 * write probe run once at startup.
 */

/**
 * Set on every consulted child. The KOPRU_ names keep an older installation, still registered in some
 * host during the rename, from serving inside a child of this one.
 */
const CHILD_MARKERS = ['CLIVOXA_DEPTH', 'CLIVOXA_JOB_ID', 'KOPRU_DEPTH', 'KOPRU_JOB_ID'] as const;
type ChildMarker = typeof CHILD_MARKERS[number];

/** Every variable whose presence makes a server refuse: our child markers and the hosts' sandbox markers. */
export const LOOP_GUARD_ENV = [...CHILD_MARKERS, 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'SANDBOX_RUNTIME'] as const;

/** The marker values a consulted child of `jobId` carries, in a stable order. */
export function childMarkers(jobId: string): Record<ChildMarker, string> {
  return { CLIVOXA_DEPTH: '1', CLIVOXA_JOB_ID: jobId, KOPRU_DEPTH: '1', KOPRU_JOB_ID: jobId };
}
export function cheapGuards(cfg: Config, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of CHILD_MARKERS) if (env[key]) return key;
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'codex sandbox';
  if (env.SANDBOX_RUNTIME) return 'claude sandbox';
  const tPasswd = realpathOr(path.join(cfg.passwdHome, '.clivoxa'));
  const tLegacy = realpathOr(path.join(cfg.passwdHome, '.kopru'));
  const tCfg = realpathOr(cfg.home);
  let cwd = '';
  try {
    cwd = realpathOr(process.cwd());
  } catch {
    cwd = '';
  }
  if (cwd && (within(cwd, tPasswd) || within(cwd, tCfg))) return 'cwd ~/.clivoxa altında';
  if (cwd && within(cwd, tLegacy)) return 'cwd korunan bir durum dizini altında';
  const tmp = realpathOr(os.tmpdir());
  if (within(tmp, path.join(tPasswd, 'tmp')) || within(tmp, path.join(tCfg, 'tmp'))) return 'TMPDIR ~/.clivoxa/tmp altında';
  if (within(tmp, path.join(tLegacy, 'tmp'))) return 'TMPDIR korunan bir durum dizini altında';
  return null;
}

/**
 * Env-independent sandbox probe: inside either CLI's sandbox, ~/.clivoxa/locks (passwd home, not
 * $HOME) is not writable. Hosts run MCP servers unsandboxed, so this never fires legitimately.
 */
export function sandboxProbe(cfg: Config): string | null {
  const dir = path.join(cfg.passwdHome, '.clivoxa', 'locks');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return `yazma denemesi: ${code}`;
  }
  const f = path.join(dir, `.probe-${process.pid}-${randomBytes(3).toString('hex')}`);
  try {
    const fd = fs.openSync(f, 'wx', 0o600);
    fs.closeSync(fd);
    fs.unlinkSync(f);
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return `yazma denemesi: ${code}`;
    return null;
  }
}

/** Ancestor walk: a current or legacy runner means we were started by a consulted agent. Fails closed. */
export function ancestryGuard(processes: { ancestorCommands(): string[] | null; languageMode(): string | null } = { ancestorCommands, languageMode: powershellLanguageMode }): string | null {
  for (let i = 0; i < 2; i++) {
    const anc = processes.ancestorCommands();
    if (anc) return anc.some((a) => a.includes('--clivoxa-runner') || a.includes('--kopru-runner')) ? 'ata süreç: clivoxa runner' : null;
  }
  // Still refused. A constrained Windows PowerShell (WDAC/AppLocker) is named, so the user learns why.
  const mode = processes.languageMode();
  if (mode && mode !== 'FullLanguage') return msg('powershell_language_mode', { mode });
  return 'üst süreçler doğrulanamadı (güvenli tarafta kalındı)';
}

/** Principals that may hold write rights on a private state directory besides its user. */
const WINDOWS_TRUSTED = new Set([
  'SY', 'S-1-5-18', // SYSTEM
  'BA', 'S-1-5-32-544', // Administrators
  'CO', 'S-1-3-0', // CREATOR OWNER: rights for whoever creates a child, which needs another grant first
  'OW', 'S-1-3-4', // OWNER RIGHTS
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // TrustedInstaller
]);
/** Access-mask bits of SDDL right codes (file objects use the directory-service names for their low bits). */
const SDDL_RIGHTS: Record<string, number> = {
  GA: 0x10000000, GX: 0x20000000, GW: 0x40000000, GR: 0x80000000, FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000, CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
};
/** Add file/subdirectory, write EA/attributes, delete child, delete, change permissions/owner, generic write/all. */
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/**
 * Who besides `userSid` and the system can change a directory with this SDDL, or null when nobody. An owner
 * other than these, a missing or null DACL, and an unknown right all count (fail closed).
 */
export function windowsForeignWriter(sddl: string, userSid: string): string | null {
  // SDDL names the built-in Administrator account (RID 500) by its alias.
  const self = (sid: string): boolean => sid === userSid || (sid === 'LA' && /-500$/.test(userSid));
  const owner = /^O:(.+?)(?=[GDS]:|$)/.exec(sddl)?.[1];
  if (!owner) return 'sahip okunamadı';
  if (!self(owner) && !WINDOWS_TRUSTED.has(owner)) return `sahip ${owner}`;
  const dacl = daclAces(sddl);
  if (!dacl) return 'izin listesi okunamadı';
  if (dacl.flags.includes('NO_ACCESS_CONTROL')) return 'izin listesi yok';
  for (const ace of dacl.aces) {
    // The first six fields never contain parentheses; a conditional ACE's expression follows them.
    const [type = '', , rights = '', , , sid = ''] = ace.split(';');
    if (DENY_ACE_TYPES.has(type)) continue;
    if (!ALLOW_ACE_TYPES.has(type)) return `bilinmeyen izin türü ${type}`;
    let mask = 0;
    if (/^0x[0-9a-f]+$/i.test(rights)) mask = Number.parseInt(rights, 16);
    else for (const code of rights.match(/../g) ?? []) mask |= SDDL_RIGHTS[code] ?? WRITE_MASK;
    // A conditional (callback) grant may apply: it counts like a plain one.
    if ((mask & WRITE_MASK) !== 0 && !self(sid) && !WINDOWS_TRUSTED.has(sid)) return `yazma izni: ${sid}`;
  }
  return null;
}

/** DACL entry types that grant (plain, object, callback) and that only deny. */
const ALLOW_ACE_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);
const DENY_ACE_TYPES = new Set(['D', 'OD', 'XD']);

/**
 * The DACL flags and entries of an SDDL string, read with balanced parentheses (a conditional ACE's
 * expression contains its own). null when the DACL cannot be read to its end, so nothing is skipped.
 */
function daclAces(sddl: string): { flags: string; aces: string[] } | null {
  const start = sddl.indexOf('D:');
  if (start < 0) return null;
  let i = start + 2;
  const flags = /^[A-Z_]*/.exec(sddl.slice(i))![0];
  i += flags.length;
  const aces: string[] = [];
  while (sddl[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < sddl.length; j++) {
      if (sddl[j] === '(') depth++;
      else if (sddl[j] === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    aces.push(sddl.slice(i + 1, j));
    i = j + 1;
  }
  // Only the SACL may follow the DACL.
  return i === sddl.length || sddl.startsWith('S:', i) ? { flags, aces } : null;
}

/** `p` with every link in its existing part resolved; a missing tail is kept as written. */
function resolvedPath(p: string): string {
  let dir = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(realpathOr(dir), ...rest);
}

/**
 * Windows: the state directory must not be writable by other users (planted jobs, locks or verification
 * records). The user's profile is private by default, so a state directory inside it needs no probe;
 * elsewhere (e.g. C:\clivoxa, which inherits "Authenticated Users: Modify") the DACL is read.
 */
function windowsOwnershipGuard(cfg: Config, readSecurity: (dir: string) => DirectorySecurity | null, languageMode: () => string | null): string | null {
  // Links resolved even where the state directory does not exist yet: a junction inside the profile
  // that leads elsewhere does not get the profile's exemption.
  const home = resolvedPath(cfg.home);
  if (within(home, realpathOr(cfg.passwdHome))) return null;
  // A state directory that does not exist yet inherits its nearest existing parent's permissions.
  let dir = home;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const security = readSecurity(dir);
  // No path in the reason: it reaches the host model as MCP instructions, and another user may name the directory.
  if (!security) {
    // A constrained PowerShell (WDAC/AppLocker) is the common cause: name it, as the ancestry guard does.
    const mode = languageMode();
    if (mode && mode !== 'FullLanguage') return msg('powershell_language_mode', { mode });
    return 'Clivoxa durum dizininin (CLIVOXA_HOME) izinleri doğrulanamadı (güvenli tarafta kalındı)';
  }
  const foreign = windowsForeignWriter(security.sddl, security.userSid);
  return foreign ? `Clivoxa durum dizinini (CLIVOXA_HOME) başka kullanıcılar değiştirebilir (${foreign}). Dizini kullanıcı profilinizin altına taşıyın veya izinlerini daraltın.` : null;
}

/** ~/.clivoxa must be ours and not group/world writable (no planted jobs or locks). */
export function ownershipGuard(cfg: Config, readSecurity: (dir: string) => DirectorySecurity | null = directorySecurity, languageMode: () => string | null = powershellLanguageMode): string | null {
  if (process.platform === 'win32') return windowsOwnershipGuard(cfg, readSecurity, languageMode);
  try {
    const st = fs.statSync(cfg.home);
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (uid >= 0 && st.uid !== uid) return '~/.clivoxa başka kullanıcıya ait';
    if ((st.mode & 0o022) !== 0) return '~/.clivoxa grup/herkes tarafından yazılabilir';
  } catch {
    /* created later with 0700 */
  }
  return null;
}

export function startupGuards(cfg: Config): string | null {
  return cheapGuards(cfg) ?? ownershipGuard(cfg) ?? sandboxProbe(cfg) ?? ancestryGuard();
}
