import path from 'node:path';
import type { Config } from '../config/config.js';

/** Where setup keeps the backups of the configurations it replaces: Clivoxa's private state, never readable by a sub-agent. */
export function backupDir(cfg: Pick<Config, 'home'>): string {
  return path.join(cfg.home, 'backups');
}
