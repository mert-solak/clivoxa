/**
 * Browser profile directories (relative to home) on `platform`: cookies, sessions and saved logins.
 * Windows names the same browsers under AppData (SECRET_DIRS_REL, and LOCALAPPDATA/APPDATA in config).
 */
export function browserProfileDirs(platform: NodeJS.Platform): string[] {
  // Whole vendor directories where they hold several channels (Chrome Beta/Canary, Opera GX).
  if (platform === 'win32') return [
    'AppData/Local/Google', 'AppData/Local/Chromium', 'AppData/Roaming/Mozilla/Firefox', 'AppData/Local/Microsoft/Edge', 'AppData/Local/BraveSoftware',
    'AppData/Local/Vivaldi', 'AppData/Roaming/Opera Software', 'AppData/Local/Opera Software',
  ];
  return [
    'Library/Application Support/Google', 'Library/Application Support/Firefox', 'Library/Safari', 'Library/Cookies',
    'Library/Application Support/Chromium', 'Library/Application Support/Microsoft Edge', 'Library/Application Support/BraveSoftware',
    'Library/Application Support/Vivaldi', 'Library/Application Support/com.operasoftware.Opera', 'Library/Application Support/Arc',
    // Firefox 147+ keeps new Linux profiles under XDG_CONFIG_HOME.
    '.mozilla', '.config/mozilla', '.config/google-chrome', '.config/google-chrome-beta', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
    '.config/vivaldi', '.config/opera', 'snap/firefox', 'snap/chromium',
    '.var/app/org.mozilla.firefox', '.var/app/com.google.Chrome', '.var/app/org.chromium.Chromium', '.var/app/com.brave.Browser', '.var/app/com.microsoft.Edge',
  ];
}

/** Directories (relative to home) that hold secrets or agent/tool state. Never a workdir; read-denied. */
export const SECRET_DIRS_REL = [...new Set([
  '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.config/op', '.azure', '.oci', '.kube', '.docker',
  '.password-store', '.terraform.d', '.codex', '.claude', '.agents', '.clivoxa',
  '.kopru', // Legacy archives remain private; the rename does not migrate or remove them.
  'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Claude',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Safari',
  'Library/Mail', 'Library/Messages', '.zsh_sessions', '.bash_sessions',
  // Credential stores of common CLIs (rclone/doctl/hcloud tokens, the GNOME keyring).
  '.config/rclone', '.config/doctl', '.config/hcloud', '.local/share/keyrings',
  ...browserProfileDirs(process.platform),
  ...(process.platform === 'win32' ? [
    'AppData/Roaming/Claude', 'AppData/Local/Claude-Data', 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud',
    'AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine',
    'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Credentials',
    'AppData/Local/Microsoft/Vault', 'AppData/Roaming/Microsoft/Vault', 'AppData/Roaming/Microsoft/Protect',
  ] : []),
])];
/** Files (relative to home) that hold secrets. */
export const SECRET_FILES_REL = [
  '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.vault-token', '.claude.json', '.docker/config.json',
  // Package-registry and service credentials.
  '.config/git/credentials', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials',
  '.composer/auth.json', '.config/composer/auth.json', '.m2/settings-security.xml', '.terraformrc',
  '.pgpass', '.my.cnf', '.s3cfg', '.boto', '.databrickscfg',
  // Shell/REPL histories often hold pasted tokens and passwords.
  '.zsh_history', '.bash_history', '.sh_history', '.python_history', '.node_repl_history', '.psql_history',
  '.mysql_history', '.sqlite_history', '.irb_history', '.lesshst', '.viminfo',
];

/**
 * Agent / editor / git-hook configuration inside a workdir that neither sub-agent may change.
 * Directories are recursive. Changes are prevented (Claude deny rules, Codex profile carve-outs)
 * and, as a backstop, reverted after every write job.
 */
export const PROTECTED_DIRS = [
  '.claude', '.codex', '.agents', '.cursor', '.husky', '.githooks', '.vscode', '.idea', '.devcontainer', '.git/hooks', '.git/info',
];
/** Top-level agent, editor and git metadata directories: `.git` plus the top-level PROTECTED_DIRS. */
export const METADATA_DIRS = ['.git', ...PROTECTED_DIRS.filter((d) => !d.includes('/'))];
/**
 * Clivoxa's own state inside a state directory, never readable by a sub-agent. scratch and tmp stay
 * readable: scratch is a job's cwd without a workdir, and the sandbox verifier's probes run under tmp.
 */
export const CLIVOXA_PRIVATE_DIRS = ['jobs', 'sessions', 'locks', 'caps', 'backups'];
export const CLIVOXA_PRIVATE_FILES = ['install.json'];
export const PROTECTED_FILES = [
  '.mcp.json', '.lsp.json', '.worktreeinclude', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md',
  '.gitattributes', '.gitmodules', '.lfsconfig', '.envrc', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml',
  'lefthook.yaml', '.lefthook.yaml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnp.cjs', '.pnp.loader.mjs',
  'bunfig.toml', '.bunfig.toml', '.bazelrc', '.devcontainer.json', '.git/config',
];
/** Paths inside protected dirs that the CLIs themselves manage (never reverted). */
export const PROTECTED_IGNORE = ['.claude/.cc-writes', '.claude/worktrees'];
/**
 * Protected paths the host app or an IDE rewrites on its own while a job runs (Claude Code stores
 * "always allow" answers in settings.local.json; JetBrains rewrites workspace state). The sandbox
 * already keeps the sub-agent out of them, so a change found afterwards is reported, never reverted.
 */
export const PROTECTED_REPORT_ONLY = [
  '.claude/settings.local.json', '.idea/workspace.xml', '.idea/shelf', '.idea/tasks.xml', '.idea/usage.statistics.xml',
  '.idea/dataSources.local.xml', '.idea/httpRequests',
];

/** Files flagged in results as "review before running" (not protected). */
export const EXECUTABLE_SURFACES = [
  /^package\.json$/, /(^|\/)Makefile$/, /(^|\/)[^/]+\.config\.(js|ts|mjs|cjs)$/, /(^|\/)conftest\.py$/, /(^|\/)pyproject\.toml$/,
  /(^|\/)tox\.ini$/, /(^|\/)noxfile\.py$/, /^\.github\/workflows\//, /(^|\/)Dockerfile[^/]*$/, /\.sh$/,
];
