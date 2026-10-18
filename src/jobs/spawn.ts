import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { jobRunnerScript } from '../system/entrypoints.js';
import type { Config } from '../config/config.js';
import { JobFiles } from './store.js';

/**
 * Start the detached runner. detached:true => setsid (new session and process group): it survives
 * the MCP server exiting and the host killing the server's process group. stdio never inherits the
 * MCP pipes (that would corrupt JSON-RPC and delay host cleanup).
 */
export function spawnRunner(cfg: Config, jobDir: string): { pid: number } {
  const script = jobRunnerScript();
  if (!fs.existsSync(script)) throw new Error(`İş çalıştırıcısı bulunamadı: ${script}`);
  let node = cfg.bins.node;
  try {
    fs.accessSync(node, fs.constants.X_OK);
  } catch {
    node = process.execPath;
  }
  const logFd = fs.openSync(path.join(jobDir, JobFiles.runnerLog), 'a', 0o600);
  try {
    // `--clivoxa-job <id>` is the ASCII liveness marker (ps may mangle non-ASCII paths).
    const child = spawn(node, [script, '--clivoxa-runner', jobDir, '--clivoxa-job', path.basename(jobDir)], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      cwd: jobDir,
      env: process.env,
    });
    // Async spawn errors must not crash the server; a runner that never starts is reaped
    // as runner_start_failed after the startup grace period.
    child.on('error', () => undefined);
    if (!child.pid) throw new Error('runner pid yok');
    child.unref();
    return { pid: child.pid };
  } finally {
    fs.closeSync(logFd);
  }
}
