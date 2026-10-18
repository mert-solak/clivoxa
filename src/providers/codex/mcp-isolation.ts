import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Config } from '../../config/config.js';
import { resolveLaunch } from '../child-env.js';
import { packageRoot } from '../../system/entrypoints.js';
import { BASE_DISABLE, MCP_ENUM_OVERRIDE, buildMcpOverride, featureFlags, type FeatureCaps } from './argv.js';
import { ensureDir0700, readJsonSafe, writeJsonAtomic } from '../../system/fs.js';

interface ListedServer {
  name: string;
  enabled: boolean;
  transport?: { command?: string; args?: string[]; url?: string; env?: Record<string, string> };
}

/** Package identity is exact: the npm name (a version, range or dist-tag may follow) or the GitHub repository (a #ref may follow). */
const OUR_PACKAGE_RE = /^(?:(?:@mertsolak\/clivoxa|kopru-mcp)(?:@[0-9A-Za-z_.*+~^<>=| -]+)?|(?:github:)?mert-solak\/clivoxa(?:#[0-9A-Za-z_./-]+)?)$/;
const OUR_ENV_RE = /^(?:CLIVOXA|KOPRU)_[A-Z0-9_]+$/;
const OUR_ENV_ASSIGNMENT_RE = /^(?:CLIVOXA|KOPRU)_[A-Z0-9_]+=/;

function unquote(value: string): string {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1) : value;
}

/** Inspect individual argv values, never arbitrary URLs or environment values as package names. */
function bridgeReference(raw: string): boolean {
  const value = unquote(raw);
  if (OUR_PACKAGE_RE.test(value)) return true;
  if (value.startsWith('--package=')) return OUR_PACKAGE_RE.test(value.slice('--package='.length));
  // A scoped npm spec must match its complete scope/name; it is not a filesystem path.
  if (value.startsWith('@') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  const root = packageRoot().replace(/\\/g, '/');
  if (normalized === root || normalized.startsWith(root + '/')) return true;
  const parts = normalized.split('/');
  // The same basename in another npm scope is a different package, including local installs.
  if (parts.some((part, i) => part === 'clivoxa' && parts[i - 1]?.startsWith('@') && parts[i - 1] !== '@mertsolak')) return false;
  if (/^(?:clivoxa|kopru(?:-mcp)?)(?:\.(?:mjs|cjs|js))?$/.test(parts.at(-1) ?? '')) return true;
  return parts.some((part, i) => /^(?:clivoxa|kopru(?:-mcp)?)$/.test(part) && parts[i + 1] === 'dist');
}

/** An explicit npm/npx package selects the executable's owner, even if its bin is named clivoxa. */
function explicitNpmPackages(command: string | undefined, args: string[]): string[] {
  if (!command || !/(?:^|[\\/])(?:npm|npx)(?:\.(?:cmd|exe))?$/i.test(unquote(command))) return [];
  const packages: string[] = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i]!;
    if ((arg === '--package' || arg === '-p') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      packages.push(args[++i]!);
    } else {
      const equal = /^(?:--package|-p)=(.+)$/.exec(arg);
      if (equal) packages.push(equal[1]!);
    }
  }
  return packages;
}

/** A server that runs this bridge (by name, env/args mentioning it, or a path inside this install). */
export function looksOurs(s: Pick<ListedServer, 'name' | 'transport'>): boolean {
  if (s.name === 'clivoxa' || s.name === 'kopru') return true;
  if (Object.keys(s.transport?.env ?? {}).some((key) => OUR_ENV_RE.test(key))) return true;
  const args = s.transport?.args ?? [];
  if (args.some((arg) => OUR_ENV_ASSIGNMENT_RE.test(arg))) return true;
  const packages = explicitNpmPackages(s.transport?.command, args);
  if (packages.some(bridgeReference)) return true;
  return [s.transport?.command, ...args].some((value) =>
    typeof value === 'string'
    && !(packages.length && /^(?:clivoxa|kopru(?:-mcp)?)$/.test(unquote(value)))
    && bridgeReference(value));
}

function codexHome(env: Record<string, string>, cfg: Config): string {
  return env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(cfg.userHome, '.codex');
}

/** Fingerprint of every config layer that can define MCP servers for cwd. */
function configFingerprint(cfg: Config, env: Record<string, string>, cwd: string): string {
  const h = createHash('sha1');
  const files = [path.join(codexHome(env, cfg), 'config.toml')];
  let d = cwd;
  for (let i = 0; i < 64; i++) {
    files.push(path.join(d, '.codex', 'config.toml'));
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      h.update(`${f}|${st.size}|${st.mtimeMs}\n`);
    } catch {
      /* missing layer */
    }
  }
  h.update(cwd);
  return h.digest('hex').slice(0, 20);
}

function listServers(cfg: Config, env: Record<string, string>, cwd: string, override: string, features: FeatureCaps | null): ListedServer[] | { error: string } {
  const bin = cfg.bins.codex!;
  const l = resolveLaunch(cfg, bin);
  const r = spawnSync(l.cmd, [...l.pre, ...featureFlags(BASE_DISABLE, features), '-c', `mcp_servers=${override}`, 'mcp', 'list', '--json'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) return { error: `codex mcp list başarısız (çıkış ${r.status ?? r.signal}): ${(r.stderr || '').slice(0, 400)}` };
  try {
    const arr = JSON.parse(r.stdout) as ListedServer[];
    if (!Array.isArray(arr)) return { error: 'codex mcp list çıktısı dizi değil' };
    return arr.filter((s) => s && typeof s.name === 'string');
  } catch {
    return { error: 'codex mcp list JSON okunamadı' };
  }
}

/**
 * Build and VALIDATE the single `-c mcp_servers={…}` override for the Codex child (cwd = its
 * workdir, so trusted project layers are included). Fails closed.
 */
export function isolateMcp(cfg: Config, capsDir: string, env: Record<string, string>, cwd: string, features: FeatureCaps | null): { override: string; names: string[] } | { error: string } {
  const fp = configFingerprint(cfg, env, cwd);
  // The policy decides which servers are disabled, so a record built under the other one is never reused.
  const cacheFile = path.join(capsDir, `mcpenum-${cfg.codexUserMcp}-${fp}.json`);
  const cached = readJsonSafe<{ override: string; names: string[]; at: number }>(cacheFile);
  if (cached && Date.now() - cached.at < 3600_000) return { override: cached.override, names: cached.names };
  const listed = listServers(cfg, env, cwd, MCP_ENUM_OVERRIDE, features);
  if ('error' in listed) return listed;
  let names = listed.map((s) => s.name);
  if (cfg.codexUserMcp === 'keep') {
    names = listed.filter(looksOurs).map((s) => s.name);
  }
  const override = buildMcpOverride(names);
  const check = listServers(cfg, env, cwd, override, features);
  if ('error' in check) return check;
  const mustBeOff = new Set(['clivoxa', 'kopru', ...names]);
  const bad = check.filter((s) => mustBeOff.has(s.name) && s.enabled);
  if (bad.length) return { error: `kapatılamayan sunucular: ${bad.map((s) => s.name).join(', ')}` };
  if (cfg.codexUserMcp === 'keep') {
    const sneaky = check.filter((s) => s.enabled && looksOurs(s));
    if (sneaky.length) return { error: `clivoxa sunucusuna benzeyen açık sunucu: ${sneaky.map((s) => s.name).join(', ')}` };
  }
  try {
    ensureDir0700(capsDir);
    writeJsonAtomic(cacheFile, { override, names, at: Date.now() });
  } catch {
    /* cache optional */
  }
  return { override, names };
}
