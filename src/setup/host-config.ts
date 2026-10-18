import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { DESKTOP_PACKAGE, defaultMaxAccess, type Access } from '../config/config.js';
import type { Target } from '../domain/ids.js';
import { envValue } from '../system/platform/index.js';

export type HostId = 'claude-code' | 'claude-desktop' | 'codex';
export interface SetupHost {
  id: HostId;
  label: string;
  file: string;
  /** The target this host's server offers: Claude hosts get ask_codex, Codex gets ask_claude. */
  role: Target;
  host: 'claude-code' | 'desktop' | 'codex';
}
export interface HostLaunch { command: string; args: string[]; env: Record<string, string> }
export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  bins: { claude?: string | null; codex?: string | null };
  /** Injection keeps discovery fixtures independent of the machine running them. */
  exists?: (file: string) => boolean;
  directories?: (directory: string) => string[];
}
/** Short names for summary lines; one line per host, whatever number of profiles it has. */
export const HOST_NAMES: Readonly<Record<HostId, string>> = Object.freeze({
  'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex',
});
/** Default label of one discovered profile, used in its messages; Desktop profiles name their package. */
export const HOST_LABELS: Readonly<Record<HostId, string>> = Object.freeze({
  'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex CLI / Desktop',
});

/** Discover existing profiles or installed applications; never create speculative profiles. */
export function discoverHosts(options: DiscoveryOptions): SetupHost[] {
  const { home, env, bins, exists = fs.existsSync } = options;
  const platform = options.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(home)) throw new Error('Setup requires an absolute user home directory.');
  const value = (name: string): string | undefined => envValue(env, name, platform);
  const absolute = (name: string, fallback?: string): string | undefined => {
    const raw = value(name);
    if (!raw) return fallback;
    if (!api.isAbsolute(raw)) throw new Error(`${name} must be an absolute directory path.`);
    return api.normalize(raw);
  };
  const claudeDir = absolute('CLAUDE_CONFIG_DIR');
  // CLAUDE_CONFIG_DIR relocates the .claude.json file itself, not merely the settings directory.
  const claudeFile = api.join(claudeDir ?? home, '.claude.json');
  const codexDir = absolute('CODEX_HOME', api.join(home, '.codex'))!;
  const codexFile = api.join(codexDir, 'config.toml');
  const local = platform === 'win32' ? absolute('LOCALAPPDATA') : undefined;
  const programs = platform === 'win32' ? absolute('ProgramFiles') : undefined;
  const apps = platform === 'darwin' ? ['/Applications', api.join(home, 'Applications')] : [];
  const appExists = (name: 'Claude' | 'Codex'): boolean => {
    if (apps.some(directory => exists(api.join(directory, `${name}.app`)))) return true;
    if (platform !== 'win32') return false;
    const candidates = [
      ...(local ? [api.join(local, 'Programs', name, `${name}.exe`), api.join(local, name, `${name}.exe`),
        api.join(local, 'Microsoft', 'WindowsApps', `${name}.exe`)] : []),
      ...(programs ? [api.join(programs, name, `${name}.exe`)] : []),
      ...(local && name === 'Claude' ? [api.join(local, 'AnthropicClaude', 'Claude.exe')] : []),
    ];
    return candidates.some(exists);
  };
  const hosts: SetupHost[] = [];
  const discoveredFiles = new Set<string>();
  const add = (id: HostId, file: string, role: SetupHost['role'], host: SetupHost['host'], label = HOST_LABELS[id]): void => {
    const key = platform === 'win32' ? file.toLowerCase() : file;
    if (discoveredFiles.has(key)) return;
    discoveredFiles.add(key);
    hosts.push({ id, label, file, role, host });
  };
  if (bins.claude || exists(claudeFile) || exists(claudeDir ?? api.join(home, '.claude'))) {
    add('claude-code', claudeFile, 'codex', 'claude-code');
  }
  let desktopDir: string | undefined;
  if (platform === 'win32') {
    // Do not guess a redirected roaming profile from USERPROFILE. APPDATA is the OS-resolved path.
    const roaming = absolute('APPDATA');
    if (roaming) desktopDir = api.join(roaming, 'Claude');
  } else if (platform === 'darwin') {
    desktopDir = api.join(home, 'Library', 'Application Support', 'Claude');
  } else {
    // Linux has no official Claude Desktop app. Support an already existing compatible profile only.
    desktopDir = api.join(absolute('XDG_CONFIG_HOME', api.join(home, '.config'))!, 'Claude');
  }
  if (desktopDir && (exists(desktopDir) || appExists('Claude'))) {
    add('claude-desktop', api.join(desktopDir, 'claude_desktop_config.json'), 'codex', 'desktop');
  }
  if (platform === 'win32' && local) {
    const packages = api.join(local, 'Packages');
    const directories = options.directories ?? ((directory: string): string[] => {
      try {
        return fs.readdirSync(directory, { withFileTypes: true })
          .filter(item => item.isDirectory()).map(item => item.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new Error('Windows application profiles could not be inspected.');
      }
    });
    // Packaged Desktop (direct MSIX "Claude_<hash>" or Store "AnthropicPBC.Claude_<hash>")
    // redirects roaming data into its own LocalCache. Only discover existing
    // profiles; do not invent a publisher ID or profile.
    const family = DESKTOP_PACKAGE;
    for (const name of directories(packages).filter(item => family.test(item)).sort()) {
      const profile = api.join(packages, name, 'LocalCache', 'Roaming', 'Claude');
      if (!exists(profile)) continue;
      add('claude-desktop', api.join(profile, 'claude_desktop_config.json'), 'codex', 'desktop',
        `Claude Desktop (${/^AnthropicPBC\./i.test(name) ? 'Microsoft Store' : 'MSIX'}: ${name})`);
    }
    // Desktop can move packaged user data out of the package into
    // %LOCALAPPDATA%\Claude-Data\<lower-case family>; that copy is then live.
    const moved = api.join(local, 'Claude-Data');
    for (const name of directories(moved).filter(item => family.test(item)).sort()) {
      const profile = api.join(moved, name);
      if (!exists(profile)) continue;
      add('claude-desktop', api.join(profile, 'claude_desktop_config.json'), 'codex', 'desktop',
        `Claude Desktop (paket dışı veri: ${name})`);
    }
  }
  if (bins.codex || exists(codexFile) || exists(codexDir) || appExists('Codex')) {
    add('codex', codexFile, 'claude', 'codex');
  }
  return hosts;
}

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = (host: SetupHost): Error => new Error(`${host.label}: configuration is invalid; no changes were made.`);

function document(host: SetupHost, text: string): Table {
  try {
    const clean = text.replace(/^\uFEFF/, '');
    const parsed: unknown = host.id === 'codex'
      ? parseToml(clean, { integersAsBigInt: true })
      : clean.trim() ? JSON.parse(clean) : {};
    if (!isTable(parsed)) throw invalid(host);
    return parsed;
  } catch { throw invalid(host); }
}

function entries(host: SetupHost, doc: Table): Table | undefined {
  const value = doc[host.id === 'codex' ? 'mcp_servers' : 'mcpServers'];
  if (value === undefined) return undefined;
  if (!isTable(value)) throw invalid(host);
  return value;
}

function entry(host: SetupHost, doc: Table): Table | undefined {
  const value = entries(host, doc)?.clivoxa;
  if (value === undefined) return undefined;
  if (!isTable(value)) throw invalid(host);
  return value;
}

function stringEnvironment(host: SetupHost, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isTable(value) || Object.values(value).some(item => typeof item !== 'string')) throw invalid(host);
  return value as Record<string, string>;
}

function serialize(host: SetupHost, doc: Table, original: string): string {
  try {
    // Integers are BigInts from parse(), so retain the TOML float/integer distinction as well as magnitude.
    const body = host.id === 'codex' ? stringifyToml(doc, { numbersAsFloat: true }) : JSON.stringify(doc, null, 2);
    if (!isDeepStrictEqual(document(host, body), doc)) throw invalid(host);
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    return body.replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, '') + eol;
  } catch { throw invalid(host); }
}

const managedEnv = new Set(['CLIVOXA_EXPOSE', 'CLIVOXA_HOST', 'CODEX_BIN', 'CODEX_JS', 'CODEX_PATH_DIR',
  'CLAUDE_BIN', 'NODE_BIN', 'GIT_BIN', 'CLIVOXA_USER_PATH']);
const remoteFields = ['type', 'transport', 'url', 'headers', 'http_headers', 'env_http_headers',
  'bearer_token', 'bearer_token_env_var', 'oauth', 'resource', 'audience', 'scopes'];

/**
 * The host configuration with the Clivoxa entry set to `launch`. A recorded read/write ceiling is the
 * user's choice and survives reinstalls; only an explicit `ceiling` (setup --max-access) replaces it.
 */
export function renderHostConfig(host: SetupHost, text: string, launch: HostLaunch, ceiling?: Access): string {
  const doc = document(host, text);
  const previous = entry(host, doc);
  if (!launch.command || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string')) throw invalid(host);
  const supplied = stringEnvironment(host, launch.env);
  const oldEnv = stringEnvironment(host, previous?.env);
  const env: Record<string, string> = { ...supplied, ...oldEnv };
  for (const key of managedEnv) {
    if (Object.hasOwn(supplied, key)) env[key] = supplied[key]!;
    else delete env[key];
  }
  env.CLIVOXA_EXPOSE = host.role;
  env.CLIVOXA_HOST = host.host;
  if (ceiling) {
    env.CLIVOXA_MAX_ACCESS = ceiling;
  } else if (previous) {
    // Preserve the old effective ceiling even if it was implicit (unknown/Desktop defaults to read).
    const oldCeiling = oldEnv.CLIVOXA_MAX_ACCESS;
    if (oldCeiling !== undefined && oldCeiling !== 'read' && oldCeiling !== 'write') throw invalid(host);
    env.CLIVOXA_MAX_ACCESS = oldCeiling ?? defaultMaxAccess(oldEnv.CLIVOXA_HOST);
  } else {
    env.CLIVOXA_MAX_ACCESS ??= 'write';
    if (env.CLIVOXA_MAX_ACCESS !== 'read' && env.CLIVOXA_MAX_ACCESS !== 'write') throw invalid(host);
  }
  if (previous?.type !== undefined && !['stdio', 'http', 'sse', 'streamable-http'].includes(String(previous.type))) throw invalid(host);
  const next: Table = { ...previous, command: launch.command, args: [...launch.args], env };
  for (const field of remoteFields) delete next[field];
  if (host.id === 'claude-code') next.type = 'stdio';
  if (host.id === 'codex') {
    next.startup_timeout_sec ??= 60n;
    next.tool_timeout_sec ??= 120n;
  }
  if (previous && isDeepStrictEqual(previous, next)) return text;
  const key = host.id === 'codex' ? 'mcp_servers' : 'mcpServers';
  doc[key] = { ...entries(host, doc), clivoxa: next };
  return serialize(host, doc, text);
}

/** The effective command includes user preferences preserved during repair. */
export function readHostLaunch(host: SetupHost, text: string): HostLaunch | null {
  const value = entry(host, document(host, text));
  if (!value || value.command === undefined) return null;
  if (typeof value.command !== 'string' || !value.command || (value.args !== undefined
    && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string')))) throw invalid(host);
  return { command: value.command, args: (value.args ?? []) as string[], env: stringEnvironment(host, value.env) };
}

/** Disabled entries remain disabled; setup must not report these as host-ready. */
export function isHostEnabled(host: SetupHost, text: string): boolean {
  const doc = document(host, text);
  const value = entry(host, doc);
  if (!value) return false;
  for (const field of ['enabled', 'disabled']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw invalid(host);
  }
  return value.enabled !== false && value.disabled !== true
    && !(Array.isArray(doc.disabledMcpServers) && doc.disabledMcpServers.includes('clivoxa'));
}

/** Stable, non-reversible ownership comparison; never store secrets from config in the install manifest. */
export function entryFingerprint(host: SetupHost, text: string): string | null {
  const value = entry(host, document(host, text));
  if (!value) return null;
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (isTable(item)) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
    if (typeof item === 'bigint') return `bigint:${item}`;
    if (typeof item === 'number') return `number:${Object.is(item, -0) ? '-0' : String(item)}`;
    if (item instanceof Date) return `date:${item.toISOString()}`;
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Caller verifies ownership against the manifest and writes this result transactionally. */
export function removeHostEntry(host: SetupHost, text: string): string {
  const doc = document(host, text);
  const servers = entries(host, doc);
  if (!entry(host, doc)) return text;
  delete servers!.clivoxa;
  if (Object.keys(servers!).length === 0) delete doc[host.id === 'codex' ? 'mcp_servers' : 'mcpServers'];
  return serialize(host, doc, text);
}
