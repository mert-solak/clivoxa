import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Config } from '../config/config.js';
import { ensureDir0700, readJsonSafe, writeJsonAtomic } from '../system/fs.js';
import { resolveLaunch } from './child-env.js';
import { NO_SHELL_DISABLE, type FeatureCaps } from './codex/argv.js';

export const MIN_CODEX = '0.162.1';
export const MIN_CLAUDE = '2.1.300';

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Stable fingerprint of a binary (realpath + size + mtime) so caches invalidate on updates. */
export function binFingerprint(bin: string): string | null {
  try {
    const real = fs.realpathSync.native(bin);
    const st = fs.statSync(real);
    return createHash('sha1').update(`${real}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function run(cfg: Config, bin: string, args: string[], env: Record<string, string>, timeout = 10_000): { ok: boolean; out: string; err: string } {
  const l = resolveLaunch(cfg, bin);
  // The detached runner has no console: without windowsHide every probe would open a visible window.
  const r = spawnSync(l.cmd, [...l.pre, ...args], { env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export interface CodexCaps extends FeatureCaps {
  version: string;
  fp: string;
}

export function parseFeatures(out: string): Record<string, string> {
  const stages: Record<string, string> = {};
  for (const l of out.split('\n')) {
    const m = /^([a-z0-9_.]+)\s+(.+?)\s+(true|false)\s*$/.exec(l.trim());
    if (m) stages[m[1]!] = m[2]!;
  }
  return stages;
}

/** A features list is usable only if it names the shell features we must be able to turn off. */
export function plausibleStages(s: Record<string, string> | undefined): boolean {
  return !!s && NO_SHELL_DISABLE.every((n) => typeof s[n] === 'string' && s[n] !== 'removed');
}

export function codexCaps(cfg: Config, capsDir: string, env: Record<string, string>): CodexCaps | { error: string } {
  const bin = cfg.bins.codex;
  if (!bin) return { error: 'CODEX_BIN yok' };
  const fp = binFingerprint(bin);
  if (!fp) return { error: `CODEX_BIN bulunamadı: ${bin}` };
  const file = path.join(capsDir, `codex-${fp}.json`);
  const cached = readJsonSafe<CodexCaps & { at: number }>(file);
  if (cached && cached.fp === fp && plausibleStages(cached.stages) && Date.now() - cached.at < 7 * 86400_000) return cached;
  const v = run(cfg, bin, ['--version'], env);
  if (!v.ok) return { error: `codex --version başarısız: ${(v.err || v.out).slice(0, 300)}` };
  const version = /(\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? '0.0.0';
  // A failed or implausible list is never cached or used: it would silently drop every --disable flag.
  const f = run(cfg, bin, ['features', 'list'], env);
  if (!f.ok) return { error: `codex features list başarısız: ${(f.err || f.out).slice(0, 300)}` };
  const stages = parseFeatures(f.out);
  if (!plausibleStages(stages)) return { error: `codex features list beklenmeyen çıktı (${NO_SHELL_DISABLE.join('/')} yok); Codex güvenle başlatılamıyor` };
  const caps: CodexCaps = { version, fp, stages };
  try {
    ensureDir0700(capsDir);
    writeJsonAtomic(file, { ...caps, at: Date.now() });
  } catch {
    /* cache is optional */
  }
  return caps;
}

export function claudeVersion(cfg: Config, env: Record<string, string>): string | { error: string } {
  const bin = cfg.bins.claude;
  if (!bin) return { error: 'CLAUDE_BIN yok' };
  const v = run(cfg, bin, ['--version'], env);
  if (!v.ok) return { error: `claude --version başarısız: ${(v.err || v.out).slice(0, 300)}` };
  return /(\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? '0.0.0';
}

/** Sandbox verification record per codex binary, written by `doctor --verify` or before the first file-access job. */
export interface SandboxRecord {
  fp: string;
  version: string;
  at: number;
  /** `review`: the read profile also held inside `codex exec review` (absent in older records). */
  profiles_verified: { ro: boolean; rw: boolean; rw_git: boolean; rw_net: boolean; review?: boolean };
  details: Record<string, string>;
  context: string;
}

export function sandboxContext(cfg: Config): string {
  const files = [path.join(cfg.codexHome, 'config.toml'), path.join(cfg.codexHome, 'auth.json'), path.join(cfg.claudeConfigDir, 'settings.json'), path.join(cfg.claudeConfigDir, '.credentials.json')];
  // Elevated Windows profiles depend on this provisioned identity. Only stamp
  // metadata: sandbox_users.json contains credentials and must never be read here.
  if (process.platform === 'win32') files.push(path.join(cfg.codexHome, '.sandbox', 'setup_marker.json'), path.join(cfg.codexHome, '.sandbox-secrets', 'sandbox_users.json'));
  const stamps = files.map((file) => { try { const stat = fs.statSync(file); return [file, stat.size, stat.mtimeMs, stat.ctimeMs]; } catch { return [file]; } });
  return createHash('sha256').update(JSON.stringify(['portable-profiles-v2', process.platform, process.arch, process.getuid?.() ?? osUser(), cfg.userHome, cfg.passwdHome, cfg.home, cfg.codexHome, cfg.claudeConfigDir, cfg.allowSlashTmp, cfg.netDomains, cfg.secretDirs, cfg.secretFiles, stamps])).digest('hex').slice(0, 24);
}
function osUser(): string { return process.env.USERNAME ?? process.env.USER ?? 'unknown'; }

export function sandboxRecordPath(capsDir: string, fp: string): string {
  return path.join(capsDir, `codex-sandbox-${fp}.json`);
}

export function readSandboxRecord(cfg: Config, capsDir: string): SandboxRecord | null {
  if (!cfg.bins.codex) return null;
  const fp = binFingerprint(cfg.bins.codex);
  if (!fp) return null;
  const r = readJsonSafe<SandboxRecord>(sandboxRecordPath(capsDir, fp));
  if (!r || r.fp !== fp || r.context !== sandboxContext(cfg) || Date.now() - r.at > 86400_000) return null;
  return r;
}
