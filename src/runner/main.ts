#!/usr/bin/env node
// Detached job runner: `node <runner script> --clivoxa-runner <jobDir>` (system/entrypoints.ts names the script).
// Started by the MCP server with {detached:true} (setsid), so it survives the server, the host's
// process-group kill and stdio closing. It runs the consulted CLI, writes answer/result files and,
// LAST, the `exit_code` commit marker.
import path from 'node:path';
import { loadConfig, layout } from '../config/config.js';
import { linkOnce, writeAtomic, writeJsonAtomic } from '../system/fs.js';
import { JobFiles, isFinished, readMeta, readRequest } from '../jobs/store.js';
import { msg } from '../shared/messages.js';
import { VERSION } from '../shared/version.js';
import type { JobResult } from '../domain/job.js';
import { Runner } from './runner.js';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--clivoxa-runner');
  const dir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!dir || !path.isAbsolute(dir)) {
    process.stderr.write('usage: node <runner script> --clivoxa-runner <absolute job dir>\n');
    process.exit(2);
  }
  // A reaper (or a cancel before start) already finalized this job: never run without locks.
  if (isFinished(dir)) process.exit(0);
  const cfg = loadConfig(process.env);
  const lay = layout(cfg);
  const req = readRequest(dir);
  if (!req) {
    writeJsonAtomic(path.join(dir, JobFiles.result), { status: 'error', error_kind: 'internal', error_message: msg('internal', { detail: 'request.json yok' }), by: 'runner', finished_at: new Date().toISOString(), child_code: null, has_answer: false, partial_answer: false } satisfies JobResult);
    writeAtomic(path.join(dir, JobFiles.exitCode), '1\n');
    process.exit(0);
  }
  // Claim the job exactly once (a second runner, or a reaper that already gave up on it, wins nothing).
  const claimed = linkOnce(path.join(dir, JobFiles.runner), JSON.stringify({ pid: process.pid, marker: `--clivoxa-job ${req.job_id}`, started_at_ms: Date.now(), node: process.execPath, version: VERSION }) + '\n');
  if (!claimed || isFinished(dir) || !readMeta(dir)) process.exit(0);
  const r = new Runner(cfg, lay, dir, req);
  await r.run();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`runner fatal: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
});
