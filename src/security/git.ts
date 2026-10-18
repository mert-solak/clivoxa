import { spawnSync } from 'node:child_process';
import type { Config } from '../config/config.js';
import { nullDevice, systemEnvironment } from '../system/platform/index.js';

/** Repository settings that could run code, neutralised for every git call Clivoxa makes. */
const BASE_CONFIG = ['core.fsmonitor=false', 'core.untrackedCache=false', `core.hooksPath=${nullDevice}`];

/** Extra neutralisation for commands that read file contents or produce diffs (status, diff). */
export const CONTENT_CONFIG = [`core.attributesFile=${nullDevice}`, 'diff.external=', 'core.pager=cat'];

export interface GitResult { ok: boolean; out: string }

/**
 * Run the configured git with hooks, fsmonitor and system config disabled, a minimal environment and
 * a 10 s timeout. `config` adds `-c` settings after the base ones.
 */
export function runHardenedGit(cfg: Config, cwd: string, args: readonly string[], options: { config?: readonly string[]; maxBuffer?: number } = {}): GitResult {
  if (!cfg.bins.git) return { ok: false, out: '' };
  const settings = [...BASE_CONFIG, ...(options.config ?? [])].flatMap((setting) => ['-c', setting]);
  const r = spawnSync(cfg.bins.git, [...settings, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    env: { ...systemEnvironment(), PATH: cfg.userPath, HOME: cfg.userHome, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}
