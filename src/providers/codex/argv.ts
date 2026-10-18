import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { childMarkers } from '../../security/guards.js';
import { TOP_GIT_READ_ONLY } from '../../security/git-layout.js';
import { PROTECTED_DIRS, PROTECTED_FILES, SECRET_DIRS_REL, SECRET_FILES_REL } from '../../security/policy.js';
import { clivoxaPrivatePaths, withRealPaths } from '../../security/workspace.js';
import { nullDevice } from '../../system/platform/index.js';
import type { Web } from '../../domain/job.js';

export type CodexSandbox = { kind: 'legacy' } | { kind: 'profiles'; name: string; toml: string };

/** Features turned off in every Codex child (only those the installed CLI lists and has not removed: version compatibility). */
export const BASE_DISABLE = [
  'hooks', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'skill_mcp_dependency_install', 'memories', 'skill_search', 'tool_suggest',
];
/** Features turned off when the consulted Codex must have no shell (no workdir). Verified inventory, 0.162.1. */
export const NO_SHELL_DISABLE = ['shell_tool', 'unified_exec', 'view_image'];

export interface FeatureCaps {
  /** feature name -> stage */
  stages: Record<string, string>;
}

export function featureFlags(names: string[], caps: FeatureCaps | null): string[] {
  const out: string[] = [];
  for (const f of names) {
    const st = caps?.stages[f];
    if (caps && (st === undefined || st === 'removed')) continue;
    out.push('--disable', f);
  }
  return out;
}

/** TOML key: bare when safe, else a quoted basic string. */
export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

export function tomlStr(s: string): string {
  return JSON.stringify(s);
}

/** Points Codex at a local metadata server (CLIVOXA_CODEX_BASE_URL, tests and doctor only). */
export function codexBaseUrlArgs(cfg: Pick<Config, 'codexBaseUrl'>): string[] {
  return cfg.codexBaseUrl ? ['-c', `openai_base_url=${tomlStr(cfg.codexBaseUrl)}`, '-c', 'model_provider="openai"'] : [];
}

/** One inline table that disables current/legacy bridge names and enumerated MCP servers. */
export function buildMcpOverride(names: string[]): string {
  const disabled = process.platform === 'win32' ? JSON.stringify(process.execPath) : '"/usr/bin/false"';
  const parts = [`clivoxa={command=${disabled},enabled=false}`, `kopru={command=${disabled},enabled=false}`];
  for (const n of [...new Set(names)].sort()) {
    if (n === 'clivoxa' || n === 'kopru') continue;
    parts.push(`${tomlKey(n)}={enabled=false}`);
  }
  return `{${parts.join(',')}}`;
}

/** Enumeration still isolates current and legacy names when either has no existing table. */
export const MCP_ENUM_OVERRIDE = buildMcpOverride([]);

export interface ProfileOpts {
  kind: 'ro' | 'rw';
  gitWrite: boolean;
  network: boolean;
  allowSlashTmp: boolean;
  /**
   * Git protection from the workdir's layout (see security/git-layout.ts): extra read-only paths (nested repos,
   * git internals) and whether the top-level `.git` may be written. Default: top-level rules only.
   */
  git?: { readOnly: string[]; topWritable: boolean };
}

/** Codex's own secrets/history inside its state dir (shell_snapshots stays readable: sandboxed shells source it). */
const CODEX_SECRET_RELS = ['auth.json', 'config.toml', 'sessions', 'archived_sessions', 'history.jsonl', 'log', '.credentials.json', ...(process.platform === 'win32' ? ['.sandbox-secrets'] : [])];

/** Absolute read-deny paths for the Codex child (profiles mode). */
export function codexReadDeny(cfg: Config): string[] {
  const homes = [...new Set([cfg.userHome, cfg.passwdHome])];
  const out: string[] = [];
  for (const h of homes) {
    for (const rel of SECRET_DIRS_REL) {
      if (rel === '.codex' || rel === '.clivoxa') continue;
      out.push(path.join(h, rel));
    }
    for (const rel of SECRET_FILES_REL) out.push(path.join(h, rel));
    // Codex's own state: deny secrets, keep shell_snapshots readable (sourced by sandboxed shells).
    for (const rel of CODEX_SECRET_RELS) out.push(path.join(h, '.codex', rel));
  }
  // Custom state dirs (CODEX_HOME / CLAUDE_CONFIG_DIR) get the same treatment as the defaults.
  for (const rel of CODEX_SECRET_RELS) out.push(path.join(cfg.codexHome, rel));
  out.push(cfg.claudeConfigDir);
  out.push(...cfg.secretDirs, ...cfg.secretFiles);
  const own = clivoxaPrivatePaths(cfg);
  out.push(...own.dirs, ...own.files);
  const unique = withRealPaths(out).sort((a, b) => a.length - b.length);
  return unique.filter((candidate, i) => !unique.slice(0, i).some((parent) => {
    const rel = path.relative(parent, candidate);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  }));
}

/**
 * Only paths that exist go into a profile. Codex's Windows sandbox creates an empty directory for a
 * missing deny path to hang its rule on, which would turn ~/.npmrc, ~/.netrc or ~/.git-credentials into
 * folders and break the tools that own them. A missing path has nothing to read; the profile is built
 * per job, so a secret created later is denied from the next job on. Any other lstat error keeps the
 * path denied.
 */
function existingPaths(paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
  });
}

/** Inline TOML for a permissions profile (used identically by exec and by the doctor's verifier). */
export function profileToml(cfg: Config, o: ProfileOpts): string {
  const fsEntries: string[] = existingPaths(codexReadDeny(cfg)).map((p) => `${tomlStr(p)}="deny"`);
  if (o.kind === 'ro') {
    return `{extends=":read-only",filesystem={${fsEntries.join(',')}}}`;
  }
  if (!o.allowSlashTmp) fsEntries.push('":slash_tmp"="read"');
  const ws: string[] = ['"."="write"'];
  const git = o.git ?? { readOnly: o.gitWrite ? TOP_GIT_READ_ONLY : [], topWritable: o.gitWrite };
  ws.push(o.gitWrite && git.topWritable ? '".git"="write"' : '".git"="read"');
  const seen = new Set(['.', '.git']);
  const ro = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    ws.push(`${tomlStr(rel)}="read"`);
  };
  for (const r of git.readOnly) ro(r);
  for (const d of PROTECTED_DIRS) if (!d.startsWith('.git/')) ro(d);
  for (const f of PROTECTED_FILES) if (!f.startsWith('.git/')) ro(f);
  fsEntries.push(`":workspace_roots"={${ws.join(',')}}`);
  return `{extends=":workspace",filesystem={${fsEntries.join(',')}},network={enabled=${o.network ? 'true' : 'false'}}}`;
}

export function profileName(o: ProfileOpts): string {
  return o.kind === 'ro' ? 'clivoxa_ro' : o.gitWrite ? (o.network ? 'clivoxa_rw_git_net' : 'clivoxa_rw_git') : o.network ? 'clivoxa_rw_net' : 'clivoxa_rw';
}

export interface CodexArgvInput {
  mode: 'new' | 'resume';
  sessionId?: string;
  access: 'read' | 'write';
  shell: boolean;
  web: Web;
  cwd: string;
  answerFile: string;
  model: string;
  effort: string;
  jobId: string;
  sandbox: CodexSandbox;
  mcpOverride: string;
  features: FeatureCaps | null;
  allowSlashTmp: boolean;
  netOpen: boolean;
  /** Run Codex's reviewer (`exec review -`): the prompt on stdin is the review request. New sessions only. */
  review?: boolean;
  /** Extra args (tests/doctor only), appended before the subcommand tail, e.g. -c openai_base_url=... */
  extra?: string[];
}

const WEB_MAP: Record<Web, string> = { off: 'disabled', search: 'cached', live: 'live' };

export function buildCodexArgv(i: CodexArgvInput): string[] {
  const sandbox: string[] =
    i.sandbox.kind === 'profiles'
      ? ['-c', `default_permissions=${tomlStr(i.sandbox.name)}`, '-c', `permissions.${i.sandbox.name}=${i.sandbox.toml}`]
      : [
          '-s', i.access === 'write' ? 'workspace-write' : 'read-only',
          ...(i.access === 'write'
            ? ['-c', `sandbox_workspace_write.network_access=${i.netOpen}`, '-c', 'sandbox_workspace_write.writable_roots=[]',
               '-c', `sandbox_workspace_write.exclude_slash_tmp=${!i.allowSlashTmp}`, '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=false']
            : []),
        ];
  const args = [
    'exec',
    ...sandbox,
    ...(process.platform === 'win32' && i.sandbox.kind === 'profiles' ? ['-c', 'windows.sandbox="elevated"'] : []),
    '-C', i.cwd,
    '--color', 'never',
    '--json',
    '-o', i.answerFile,
    '--skip-git-repo-check',
    '--ignore-rules',
    ...featureFlags(BASE_DISABLE, i.features),
    // Never filtered through caps: if a future codex renames one of these, it exits with
    // "Unknown feature flag" (fail closed) instead of silently giving a shell to a no-workdir Codex.
    ...(i.shell ? [] : NO_SHELL_DISABLE.flatMap((f) => ['--disable', f])),
    ...(i.model ? ['-m', i.model] : []),
    ...(i.effort ? ['-c', `model_reasoning_effort=${tomlStr(i.effort)}`] : []),
    '-c', 'approval_policy="never"',
    '-c', 'approvals_reviewer="user"',
    '-c', `web_search=${tomlStr(WEB_MAP[i.web])}`,
    '-c', 'notify=[]',
    // Codex's child shell carries the same markers, so an MCP it starts refuses too.
    ...Object.entries(childMarkers(i.jobId)).flatMap(([key, value]) => ['-c', `shell_environment_policy.set.${key}=${tomlStr(value)}`]),
    '-c', `shell_environment_policy.set.NPM_CONFIG_USERCONFIG=${tomlStr(nullDevice)}`,
    '-c', 'skills.include_instructions=false',
    '-c', 'memories.generate_memories=false',
    '-c', 'memories.use_memories=false',
    '-c', `mcp_servers=${i.mcpOverride}`,
    ...(i.extra ?? []),
  ];
  if (i.mode === 'resume') {
    if (i.review) throw new Error('a review is always a new session');
    if (!i.sessionId) throw new Error('resume needs sessionId');
    return [...args, 'resume', '--', i.sessionId, '-'];
  }
  return i.review ? [...args, 'review', '-'] : [...args, '-'];
}

/** Replace secret-bearing values for logging/meta (the MCP override and profile TOML are summarized). */
export function redactCodexArgv(argv: string[]): string[] {
  return argv.map((a) => {
    if (a.startsWith('mcp_servers=')) {
      const n = (a.match(/=\{enabled=false\}|enabled=false\}/g) ?? []).length;
      return `mcp_servers=<${n} sunucu kapatıldı>`;
    }
    if (/^permissions\.[a-z_]+=/.test(a)) return a.replace(/=.*/s, '=<profil>');
    return a;
  });
}
