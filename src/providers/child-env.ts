import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../config/config.js';
import type { Target } from '../domain/ids.js';
import { childMarkers } from '../security/guards.js';
import { executableLaunch } from '../system/executables.js';
import { nullDevice, WINDOWS_ENV_KEYS } from '../system/platform/index.js';

const ALLOW = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', '__CF_USER_TEXT_ENCODING',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CLAUDE_CONFIG_DIR',
  ...WINDOWS_ENV_KEYS,
];
/**
 * Claude's login and provider settings reach only a Claude child: a Codex child (and its shell) does not
 * see them unless the user passes one explicitly with CLIVOXA_CHILD_ENV_PASS.
 */
const CLAUDE_ONLY = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

/** macOS "admin" group: its members can already sudo, so its write bit adds no new writer. */
const DARWIN_ADMIN_GID = 80;

/**
 * Only absolute, existing directories owned by root or the user, never world-writable, and
 * group-writable only for macOS's admin group (Homebrew's installer leaves /opt/homebrew/bin 775
 * user:admin on purpose; dropping it would hide node/npm/gh from the sub-agent's shell).
 */
export function filterPath(entries: string[], platform: NodeJS.Platform = process.platform): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const out: string[] = [];
  for (const e of entries) {
    if (!e || !path.isAbsolute(e)) continue;
    try {
      const st = fs.statSync(e);
      if (!st.isDirectory()) continue;
      if (platform !== 'win32' && uid >= 0 && st.uid !== 0 && st.uid !== uid) continue;
      if (platform !== 'win32' && st.mode & 0o002) continue;
      if (platform !== 'win32' && st.mode & 0o020 && !(platform === 'darwin' && st.gid === DARWIN_ADMIN_GID)) continue;
      out.push(e);
    } catch {
      /* missing */
    }
  }
  return [...new Set(out)];
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function buildPath(cfg: Config, cliBin: string | null): string {
  const dirs: string[] = [];
  if (cfg.bins.codexPathDir) dirs.push(cfg.bins.codexPathDir);
  dirs.push(path.dirname(cfg.bins.node));
  if (cliBin) {
    dirs.push(path.dirname(cliBin));
    try {
      dirs.push(path.dirname(fs.realpathSync.native(cliBin)));
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'win32') dirs.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  dirs.push(...cfg.userPath.split(path.delimiter));
  return dedupe(filterPath(dedupe(dirs))).join(path.delimiter);
}

export interface ChildEnvOpts {
  target: Target;
  jobId: string;
  tmpDir: string;
  cliBin: string | null;
}

/** Construct the child CLI environment from an allowlist (never logged except variable names). */
export function buildChildEnv(cfg: Config, src: NodeJS.ProcessEnv, o: ChildEnvOpts): { env: Record<string, string>; dropped: string[] } {
  const env: Record<string, string> = {};
  const allow = new Set([...ALLOW, ...(o.target === 'claude' ? CLAUDE_ONLY : []), ...cfg.childEnvPass]);
  const canonical = new Map([...allow].map((key) => [key.toUpperCase(), key]));
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const allowedKey = allow.has(k) ? k : process.platform === 'win32' ? canonical.get(k.toUpperCase()) : undefined;
    if (allowedKey) env[allowedKey] = v;
    else dropped.push(k);
  }
  let info: os.UserInfo<string> | null = null;
  try {
    info = os.userInfo();
  } catch {
    info = null;
  }
  env.HOME = cfg.userHome;
  env.CODEX_HOME = cfg.codexHome;
  // Setting this variable also relocates Claude's global .claude.json. Preserve
  // the CLI's default when no override was requested, including Desktop launches.
  if (env.CLAUDE_CONFIG_DIR || cfg.claudeConfigDir !== path.join(cfg.cliHome, '.claude')) {
    env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
  }
  if (info) {
    env.USER ??= info.username;
    env.LOGNAME ??= info.username;
    if (!env.SHELL && info.shell) env.SHELL = info.shell;
  }
  env.LANG ??= 'en_US.UTF-8';
  env.PATH = buildPath(cfg, o.cliBin);
  env.TMPDIR = o.tmpDir;
  env.TEMP = o.tmpDir;
  env.TMP = o.tmpDir;
  Object.assign(env, childMarkers(o.jobId));
  env.TERM = 'dumb';
  env.NO_COLOR = '1';
  env.NPM_CONFIG_USERCONFIG = nullDevice;
  if (o.target === 'claude') {
    env.CLAUDE_CODE_TMPDIR = o.tmpDir;
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.DISABLE_AUTOUPDATER = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }
  return { env, dropped: dropped.sort() };
}

/** How to launch a CLI: node-shebang scripts are run through NODE_BIN (GUI apps lack node on PATH). */
export function resolveLaunch(cfg: Config, bin: string): { cmd: string; pre: string[] } {
  return executableLaunch(bin, cfg.bins.node);
}
