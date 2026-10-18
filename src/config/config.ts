import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { targetFromName, type Target } from '../domain/ids.js';
import { discoverExecutable, resolveExecutable } from '../system/executables.js';

export type Access = 'read' | 'write';
export type Host = 'claude-code' | 'desktop' | 'codex' | 'unknown';

export interface Config {
  expose: Target | null;
  host: Host;
  /** ~/.clivoxa (or CLIVOXA_HOME). Absolute. */
  home: string;
  /** Real home directory from the passwd database (not $HOME). Used by env-independent guards. */
  passwdHome: string;
  /** $HOME (or passwd home) used for "~" expansion of user paths. */
  userHome: string;
  /** Where the CLIs keep ~/.claude.json, ~/.claude and ~/.codex: USERPROFILE on Windows (they ignore $HOME there), else userHome. */
  cliHome: string;
  /** Codex state dir (CODEX_HOME or ~/.codex) and Claude config dir (CLAUDE_CONFIG_DIR or ~/.claude): read-denied in children. */
  codexHome: string;
  claudeConfigDir: string;
  bins: {
    codex: string | null;
    codexJs: string | null;
    codexPathDir: string | null;
    claude: string | null;
    node: string;
    git: string | null;
  };
  userPath: string;
  // Install-time ceilings (the calling model can never change them).
  maxAccess: Access;
  codexNetwork: 'deny' | 'open';
  claudeNetwork: 'allowlist' | 'deny';
  allowGitWrite: boolean;
  codexSandbox: 'auto' | 'legacy' | 'profiles';
  protectedPolicy: 'revert' | 'report';
  claudeAgent: boolean;
  codexUserMcp: 'off' | 'keep';
  secretPolicy: 'redact' | 'block' | 'warn' | 'off';
  extraRoots: string[];
  netDomains: string[];
  allowSlashTmp: boolean;
  // Defaults and tuning.
  codexModel: string;
  claudeModel: string;
  codexDefaultEffort: string;
  claudeDefaultEffort: string;
  defaultWaitS: number;
  maxWaitS: number;
  pollMs: number;
  maxJobMinutes: number;
  maxRunningPerTarget: number;
  maxRunningTotal: number;
  maxPromptBytes: number;
  maxAnswerChars: number;
  cancelGraceMs: number;
  startupGraceMs: number;
  childEnvPass: string[];
  logLevel: 'info' | 'debug';
  /** Allow API-key auth in the Claude child (contract tests / deliberate API users). */
  allowApiKeyAuth: boolean;
  /** Loopback-only model endpoint override for offline contract tests and the doctor. */
  codexBaseUrl: string | null;
  secretDirs: string[];
  secretFiles: string[];
}

export const DEFAULT_NET_DOMAINS = [
  'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
  'rubygems.org', 'repo.maven.apache.org', 'dl.google.com',
];

const HOSTS: Host[] = ['claude-code', 'desktop', 'codex'];

function str(env: NodeJS.ProcessEnv, k: string): string | undefined {
  const v = env[k];
  return v === undefined || v === '' ? undefined : v;
}

function int(env: NodeJS.ProcessEnv, k: string, def: number, min: number, max: number): number {
  const v = str(env, k);
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function bool(env: NodeJS.ProcessEnv, k: string, def: boolean): boolean {
  const v = str(env, k);
  if (v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** One of `allowed` (case and surrounding space ignored); `def` when unset, `invalid` (default `def`) when unrecognised. */
function oneOf<T extends string>(env: NodeJS.ProcessEnv, k: string, allowed: readonly T[], def: T, invalid: T = def): T {
  const raw = str(env, k);
  if (raw === undefined) return def;
  const v = raw.trim().toLowerCase() as T;
  return allowed.includes(v) ? v : invalid;
}

function realIfExists(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Same config with `home` canonicalized (call after creating the directory on first start). */
export function withCanonicalHome(cfg: Config): Config {
  const real = realIfExists(cfg.home);
  return real === cfg.home ? cfg : Object.freeze({ ...cfg, home: real });
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (/^~[\\/]/.test(p)) return path.join(home, p.slice(2));
  return p;
}

function absOrNull(v: string | undefined, home: string): string | null {
  if (!v) return null;
  const e = expandHome(v, home);
  return path.isAbsolute(e) ? e : null;
}

/** Packaged Claude Desktop families, as setup discovers them: direct MSIX "Claude_<hash>", Store "AnthropicPBC.Claude_<hash>". */
export const DESKTOP_PACKAGE = /^(?:AnthropicPBC\.)?Claude_[a-z0-9]{13}$/i;

/** LocalCache of every packaged Claude Desktop under one %LOCALAPPDATA%; all of Packages when it cannot be listed. */
function desktopPackageCaches(local: string): string[] {
  const packages = path.join(local, 'Packages');
  try {
    return fs.readdirSync(packages).filter((name) => DESKTOP_PACKAGE.test(name)).map((name) => path.join(packages, name, 'LocalCache'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [packages];
  }
}

/** The ceiling of a registration that names none: terminal hosts may write, Desktop and unknown hosts read. */
export function defaultMaxAccess(host: string | undefined): Access {
  return host === 'claude-code' || host === 'codex' ? 'write' : 'read';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let passwdHome = os.homedir();
  try {
    passwdHome = os.userInfo().homedir || passwdHome;
  } catch {
    /* keep os.homedir() */
  }
  const suppliedHome = str(env, 'HOME') ?? str(env, 'USERPROFILE');
  const userHome = suppliedHome && path.isAbsolute(suppliedHome) ? suppliedHome : passwdHome;
  // On Windows, Claude Code (Node's os.homedir()) and Codex resolve their own files from the user profile, never from HOME.
  const profile = process.platform === 'win32' ? str(env, 'USERPROFILE') : undefined;
  const cliHome = profile && path.isAbsolute(profile) ? profile : userHome;
  const expose: Target | null = targetFromName(str(env, 'CLIVOXA_EXPOSE'));
  const hostRaw = str(env, 'CLIVOXA_HOST') as Host | undefined;
  const host: Host = hostRaw && HOSTS.includes(hostRaw) ? hostRaw : 'unknown';
  // Canonical when it exists: runners are started with real job dirs, and every probe/lock must spell them the same.
  const home = realIfExists(absOrNull(str(env, 'CLIVOXA_HOME'), userHome) ?? path.join(userHome, '.clivoxa'));
  const extraRoots = (str(env, 'CLIVOXA_EXTRA_ROOTS') ?? '')
    .split(path.delimiter)
    .map((s) => expandHome(s.trim(), userHome))
    .filter((s) => s && path.isAbsolute(s));
  const netDomains = (str(env, 'CLIVOXA_NET_DOMAINS') ?? DEFAULT_NET_DOMAINS.join(','))
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9.-]+$/.test(s));
  const childEnvPass = (str(env, 'CLIVOXA_CHILD_ENV_PASS') ?? '')
    .split(/[,\s:]+/)
    .filter((s) => /^[A-Z_][A-Z0-9_]*$/.test(s));
  // Unset uses the host default; a value Clivoxa does not recognise is read-only, never the weaker default.
  const maxAccessRaw = str(env, 'CLIVOXA_MAX_ACCESS')?.trim().toLowerCase();
  const maxAccess: Access = maxAccessRaw === undefined ? defaultMaxAccess(host) : maxAccessRaw === 'write' ? 'write' : 'read';
  const maxWaitS = int(env, 'CLIVOXA_MAX_WAIT_S', 50, 0, 50);
  const executable = (key: string, name: string): string | null => {
    const value = str(env, key);
    if (!value) return discoverExecutable(name, env, userHome);
    const absolute = absOrNull(value, userHome);
    if (!absolute) throw new Error(`${key} must be an absolute executable path.`);
    return resolveExecutable(absolute) ?? absolute;
  };
  const secretDirs = ['GH_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR'].flatMap((key) => {
    const value = absOrNull(str(env, key), userHome);
    return value ? [value] : [];
  });
  const xdg = absOrNull(str(env, 'XDG_CONFIG_HOME'), userHome);
  // A relocated config home moves the browsers' profiles with it.
  if (xdg) secretDirs.push(...['gh', 'gcloud', 'google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware', 'microsoft-edge', 'vivaldi', 'opera'].map((rel) => path.join(xdg, rel)));
  if (process.platform === 'win32') {
    for (const [key, rels] of [
      ['APPDATA', ['Claude', 'GitHub CLI', 'gcloud', 'Mozilla/Firefox', 'Opera Software', 'Microsoft/Credentials', 'Microsoft/Vault', 'Microsoft/Protect', 'Microsoft/Windows/PowerShell/PSReadLine']],
      ['LOCALAPPDATA', ['Google', 'Chromium', 'Microsoft/Edge', 'BraveSoftware', 'Vivaldi', 'Opera Software', 'Microsoft/Credentials', 'Microsoft/Vault', 'Claude-Data']],
    ] as const) {
      const root = absOrNull(str(env, key), userHome);
      if (root) secretDirs.push(...rels.map((rel) => path.join(root, rel)));
    }
    // Packaged Desktop keeps its profile, and every AppData write made inside it, in the package's LocalCache.
    const locals = [absOrNull(str(env, 'LOCALAPPDATA'), userHome), ...[userHome, passwdHome].map((h) => path.join(h, 'AppData', 'Local'))];
    for (const local of new Set(locals)) if (local) secretDirs.push(...desktopPackageCaches(local));
  }
  const secretFiles = ['NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'NPM_CONFIG_GLOBALCONFIG', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS'].flatMap((key) => {
    const value = absOrNull(str(env, key), userHome);
    return value ? [value] : [];
  });
  return Object.freeze({
    expose,
    host,
    home,
    passwdHome,
    userHome,
    cliHome,
    codexHome: absOrNull(str(env, 'CODEX_HOME'), userHome) ?? path.join(cliHome, '.codex'),
    claudeConfigDir: absOrNull(str(env, 'CLAUDE_CONFIG_DIR'), userHome) ?? path.join(cliHome, '.claude'),
    bins: Object.freeze({
      codex: executable('CODEX_BIN', 'codex'),
      codexJs: absOrNull(str(env, 'CODEX_JS'), userHome),
      codexPathDir: absOrNull(str(env, 'CODEX_PATH_DIR'), userHome),
      claude: executable('CLAUDE_BIN', 'claude'),
      node: absOrNull(str(env, 'NODE_BIN'), userHome) ?? process.execPath,
      git: executable('GIT_BIN', 'git'),
    }),
    userPath: str(env, 'CLIVOXA_USER_PATH') ?? env.PATH ?? env.Path ?? '',
    secretDirs,
    secretFiles,
    maxAccess,
    codexNetwork: oneOf(env, 'CLIVOXA_CODEX_NETWORK', ['deny', 'open'] as const, 'deny'),
    claudeNetwork: oneOf(env, 'CLIVOXA_CLAUDE_NETWORK', ['allowlist', 'deny'] as const, 'allowlist', 'deny'),
    allowGitWrite: bool(env, 'CLIVOXA_ALLOW_GIT_WRITE', true),
    codexSandbox: oneOf(env, 'CLIVOXA_CODEX_SANDBOX', ['auto', 'legacy', 'profiles'] as const, 'auto'),
    protectedPolicy: oneOf(env, 'CLIVOXA_PROTECTED_POLICY', ['revert', 'report'] as const, 'revert'),
    claudeAgent: bool(env, 'CLIVOXA_CLAUDE_AGENT', false),
    codexUserMcp: oneOf(env, 'CLIVOXA_CODEX_USER_MCP', ['off', 'keep'] as const, 'off'),
    secretPolicy: oneOf(env, 'CLIVOXA_SECRET_POLICY', ['redact', 'block', 'warn', 'off'] as const, 'redact'),
    extraRoots,
    netDomains,
    allowSlashTmp: bool(env, 'CLIVOXA_ALLOW_SLASH_TMP', false),
    codexModel: str(env, 'CODEX_MODEL') ?? '',
    claudeModel: str(env, 'CLAUDE_MODEL') ?? '',
    codexDefaultEffort: str(env, 'CLIVOXA_CODEX_DEFAULT_EFFORT') ?? '',
    claudeDefaultEffort: str(env, 'CLIVOXA_CLAUDE_DEFAULT_EFFORT') ?? '',
    defaultWaitS: Math.min(maxWaitS, int(env, 'CLIVOXA_DEFAULT_WAIT_S', 45, 0, 50)),
    maxWaitS,
    pollMs: int(env, 'CLIVOXA_POLL_MS', 500, 20, 5000),
    maxJobMinutes: int(env, 'CLIVOXA_MAX_JOB_MINUTES', 60, 1, 24 * 60),
    maxRunningPerTarget: int(env, 'CLIVOXA_MAX_RUNNING_PER_TARGET', 3, 1, 50),
    maxRunningTotal: int(env, 'CLIVOXA_MAX_RUNNING_TOTAL', 4, 1, 100),
    maxPromptBytes: int(env, 'CLIVOXA_MAX_PROMPT_BYTES', 800_000, 1000, 20_000_000),
    maxAnswerChars: int(env, 'CLIVOXA_MAX_ANSWER_CHARS', 40_000, 1000, 2_000_000),
    cancelGraceMs: int(env, 'CLIVOXA_CANCEL_GRACE_MS', 8000, 50, 120_000),
    startupGraceMs: int(env, 'CLIVOXA_STARTUP_GRACE_MS', 20_000, 200, 600_000),
    childEnvPass,
    logLevel: str(env, 'CLIVOXA_LOG') === 'debug' ? 'debug' : 'info',
    allowApiKeyAuth: bool(env, 'CLIVOXA_ALLOW_API_KEY_AUTH', false),
    codexBaseUrl: /^http:\/\/127\.0\.0\.1:\d{2,5}\/v1$/.test(str(env, 'CLIVOXA_CODEX_BASE_URL') ?? '') ? env.CLIVOXA_CODEX_BASE_URL! : null,
  });
}

export interface Layout {
  home: string;
  jobs: string;
  sessions: string;
  locks: string;
  scratch: string;
  tmp: string;
  caps: string;
}

export function layout(cfg: Pick<Config, 'home'>): Layout {
  return {
    home: cfg.home,
    jobs: path.join(cfg.home, 'jobs'),
    sessions: path.join(cfg.home, 'sessions'),
    locks: path.join(cfg.home, 'locks'),
    scratch: path.join(cfg.home, 'scratch'),
    tmp: path.join(cfg.home, 'tmp'),
    caps: path.join(cfg.home, 'caps'),
  };
}
