import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { clivoxaPrivatePaths, secretPaths, withRealPaths } from '../../security/workspace.js';
import { TOP_GIT_READ_ONLY } from '../../security/git-layout.js';
import { PROTECTED_DIRS, PROTECTED_FILES, SECRET_DIRS_REL, SECRET_FILES_REL } from '../../security/policy.js';
import type { Web } from '../../domain/job.js';


export interface ClaudeArgvInput {
  mode: 'new' | 'resume';
  sessionId: string;
  access: 'read' | 'write';
  shell: boolean;
  web: Web;
  network: boolean;
  gitWrite: boolean;
  cwd: string;
  tmpDir: string;
  model: string;
  effort: string;
  jobId: string;
  agent: boolean;
  gitDirs: string[];
  /** Workdir-relative paths kept read-only beyond the top-level `.git` rule (nested repos, git internals; security/git-layout.ts). */
  gitReadOnly?: string[];
  userDeny: string[];
  files?: boolean;
  /**
   * Owner-only file that carries the settings to `--settings` (writeClaudeSettings). Inline JSON can pass
   * Windows' 32K command-line limit. It lives in the private job directory, never in `tmpDir`: the child
   * may write there, and Claude Code reloads a changed settings file.
   */
  settingsFile: string;
}

/** `Read(//abs)` rule form for an absolute path. */
function rule(tool: string, abs: string, dir: boolean): string {
  const normalized = abs.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, drive: string) => '/' + drive.toLowerCase() + '/');
  return `${tool}(/${normalized}${dir ? '/**' : ''})`;
}

/** Read-deny rules for a path and, when it resolves elsewhere, its real location. */
function readRules(abs: string, dir: boolean): string[] {
  return withRealPaths([abs]).map((p) => rule('Read', p, dir));
}

/** Claude internals: deny secrets/history, keep shell-snapshots readable (Bash sources it). */
function claudeInternals(dir: string, out: string[]): void {
  for (const rel of ['projects', 'file-history', 'todos', 'sessions']) out.push(...readRules(path.join(dir, rel), true));
  // .claude.json lives here when CLAUDE_CONFIG_DIR relocates the profile (OAuth account, MCP env tokens).
  for (const rel of ['.claude.json', '.credentials.json', 'settings.json', 'settings.local.json', 'history.jsonl']) out.push(...readRules(path.join(dir, rel), false));
}

/** Read-deny rules for the Claude child: secrets, Claude/Codex internals, clivoxa internals. */
export function claudeReadDeny(cfg: Config): string[] {
  const homes = [...new Set([cfg.userHome, cfg.passwdHome])];
  const out: string[] = [];
  for (const h of homes) {
    for (const rel of SECRET_DIRS_REL) {
      if (rel === '.claude' || rel === '.clivoxa') continue; // handled precisely below
      out.push(...readRules(path.join(h, rel), true));
    }
    for (const rel of SECRET_FILES_REL) out.push(...readRules(path.join(h, rel), false));
    claudeInternals(path.join(h, '.claude'), out);
  }
  // Custom state dirs (CLAUDE_CONFIG_DIR / CODEX_HOME) get the same treatment as the defaults.
  claudeInternals(cfg.claudeConfigDir, out);
  out.push(...readRules(cfg.codexHome, true));
  out.push(...cfg.secretDirs.flatMap((p) => readRules(p, true)), ...cfg.secretFiles.flatMap((p) => readRules(p, false)));
  const own = clivoxaPrivatePaths(cfg);
  out.push(...own.dirs.flatMap((p) => readRules(p, true)), ...own.files.flatMap((p) => readRules(p, false)));
  return [...new Set(out)];
}

export function protectedAbs(cwd: string): { dirs: string[]; files: string[] } {
  return {
    dirs: PROTECTED_DIRS.map((d) => path.join(cwd, d)),
    files: PROTECTED_FILES.map((f) => path.join(cwd, f)),
  };
}

const RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(\(.{0,480}\))?$/s;

/**
 * Collect the user's own deny rules (permissions.deny, and ask→deny) from Claude settings files.
 * `--restricted` ignores those files, so they are re-applied as data. Never allow/hooks/env.
 */
export function mergeUserDeny(cfg: Config, cwd: string): { rules: string[]; warnings: string[] } {
  // The user's own layers come first (~/.claude, and CLAUDE_CONFIG_DIR, the child's user layer): the
  // workdir is untrusted and must not push them past the 200-rule cap with rules of its own.
  const files = [...new Set([
    path.join(cfg.userHome, '.claude', 'settings.json'),
    path.join(cfg.claudeConfigDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ])];
  const rules: string[] = [];
  const warnings: string[] = [];
  let dropped = 0;
  for (const f of files) {
    let raw: string;
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile() || st.size > 1_000_000) continue;
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    try {
      const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { permissions?: { deny?: unknown; ask?: unknown } };
      for (const key of ['deny', 'ask'] as const) {
        const arr = j.permissions?.[key];
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          // A rule repeated across files (a copied or case-variant profile) must not use up the cap.
          if (typeof r !== 'string' || r.length > 500 || !RULE_RE.test(r) || rules.includes(r)) continue;
          if (rules.length < 200) rules.push(r);
          else dropped++;
        }
      }
    } catch {
      warnings.push(`${f}: JSON okunamadı (kullanıcı reddetme kuralları atlandı)`);
    }
  }
  if (dropped) warnings.push(`${dropped} reddetme kuralı 200 kural sınırını aştığı için alt ajana uygulanmadı (önce kullanıcı ayarları, sonra proje ayarları okunur)`);
  return { rules: [...new Set(rules)], warnings };
}

export function buildClaudeSettings(cfg: Config, i: ClaudeArgvInput): Record<string, unknown> {
  const deny = [...claudeReadDeny(cfg), ...i.userDeny];
  const common = { disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true };
  const permCommon = { disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable' };
  const secrets = secretPaths(cfg);
  // The Bash sandbox needs Clivoxa's private state denied too, not only the Read tool: the state dir
  // itself stays readable (the child's cwd and TMPDIR live there).
  const own = clivoxaPrivatePaths(cfg);
  const denied = [...secrets.dirs, ...secrets.files, ...own.dirs, ...own.files].filter((p) => ![path.join(cfg.userHome, '.claude'), path.join(cfg.passwdHome, '.claude'), cfg.home].includes(p)).sort((a,b)=>a.length-b.length);
  const denyRead = denied.filter((candidate,i) => !denied.slice(0,i).some((parent) => candidate === parent || candidate.startsWith(parent + path.sep)));
  if (i.access === 'read') {
    return {
      permissions: { deny, blockReadsOutsideWorkingDirectories: true, ...permCommon },
      ...(i.shell
        ? {
            sandbox: {
              enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
              filesystem: { denyRead, denyWrite: [i.cwd], allowWrite: [i.tmpDir] },
              network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
            },
          }
        : {}),
      ...common,
    };
  }
  const prot = protectedAbs(i.cwd);
  const gitDeny = i.gitWrite ? [] : [...new Set([path.join(i.cwd, '.git'), ...i.gitDirs])];
  const gitRO = (i.gitReadOnly ?? (i.gitWrite ? TOP_GIT_READ_ONLY : [])).map((r) => path.join(i.cwd, r));
  const editDeny = [
    ...prot.dirs.flatMap((d) => [rule('Edit', d, false), rule('Edit', d, true)]),
    ...prot.files.map((f) => rule('Edit', f, false)),
    ...[...gitDeny, ...gitRO].flatMap((d) => [rule('Edit', d, false), rule('Edit', d, true)]),
  ];
  return {
    permissions: { deny: [...new Set([...deny, ...editDeny])], ...permCommon },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      filesystem: { denyRead, denyWrite: [...new Set([...prot.dirs, ...prot.files, ...gitDeny, ...gitRO])], allowWrite: [i.tmpDir] },
      network: { allowedDomains: i.network ? cfg.netDomains : [], strictAllowlist: true, allowLocalBinding: false },
    },
    ...common,
  };
}

export function claudeToolSets(i: Pick<ClaudeArgvInput, 'access' | 'shell' | 'web' | 'agent' | 'files'>): { tools: string[]; allowed: string[]; disallowed: string[] } {
  const web = i.web === 'off' ? [] : i.web === 'search' ? ['WebSearch'] : ['WebSearch', 'WebFetch'];
  if (i.access === 'write') {
    return {
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TaskStop', ...web, ...(i.agent ? ['Agent'] : [])],
      allowed: web,
      disallowed: ['PowerShell', 'Monitor', 'mcp__*', ...(i.agent ? [] : ['Agent'])],
    };
  }
  return {
    tools: [...(i.files === false ? [] : ['Read', 'Glob', 'Grep']), ...(i.shell ? ['Bash'] : []), ...web],
    allowed: web,
    disallowed: ['Edit', 'Write', 'NotebookEdit', 'PowerShell', 'Monitor', 'Agent', 'mcp__*', ...(i.shell ? [] : ['Bash']), ...(i.files === false ? ['Read', 'Glob', 'Grep'] : [])],
  };
}

/** Writes the child's settings to `file` for `--settings`: a new owner-only file, never one already there. */
export function writeClaudeSettings(file: string, settings: Record<string, unknown>): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
}

/** The child's argv. Its settings travel in `i.settingsFile`, which the caller writes first (writeClaudeSettings). */
export function buildClaudeArgv(i: ClaudeArgvInput): string[] {
  const sets = claudeToolSets(i);
  const profile = i.access === 'write' && i.gitWrite ? ['--setting-sources', ''] : ['--restricted'];
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    ...(i.model ? ['--model', i.model] : []),
    ...(i.effort ? ['--effort', i.effort] : []),
    '--name', `clivoxa-${i.jobId}`,
    '--system-prompt-snapshot', 'off',
    ...profile,
    '--strict-mcp-config', '--mcp-config={"mcpServers":{}}',
    '--disable-slash-commands',
    '--permission-prompts', 'none',
    '--permission-mode', i.access === 'write' ? 'acceptEdits' : 'dontAsk',
    `--tools=${sets.tools.join(',')}`,
    ...(sets.allowed.length ? [`--allowedTools=${sets.allowed.join(',')}`] : []),
    `--disallowedTools=${sets.disallowed.join(',')}`,
    '--settings', i.settingsFile,
  ];
  return i.mode === 'resume' ? [...args, `--resume=${i.sessionId}`] : [...args, '--session-id', i.sessionId];
}

export function redactClaudeArgv(argv: string[]): string[] {
  return argv.map((a, idx) => (argv[idx - 1] === '--settings' ? '<settings>' : a));
}
