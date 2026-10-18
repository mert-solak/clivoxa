#!/usr/bin/env node
// Minimal raw JSON-RPC client (no SDK) that checks initialize, tools/list and tools/call for both
// roles, using the fake codex/claude CLIs (no model calls, no cost).
//   npm run smoke
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist', 'index.js');
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-smoke-')));
let failures = 0;

function rpcSession(role, extra = {}) {
  const env = {
    HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, CLIVOXA_EXPOSE: role, CLIVOXA_HOME: path.join(home, '.clivoxa'),
    CODEX_BIN: path.join(ROOT, 'test', 'fakes', 'codex.mjs'), CLAUDE_BIN: path.join(ROOT, 'test', 'fakes', 'claude.mjs'), NODE_BIN: process.execPath,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claudecfg'), CLIVOXA_POLL_MS: '50',
    ...extra,
  };
  const p = spawn(process.execPath, [DIST], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const myId = ++id;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${method} zaman aşımı`)), 60_000);
        waiters.set(myId, (m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    },
    notify(method, params) {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      p.stdin.end();
      return new Promise((r) => p.on('close', r));
    },
  };
}

function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'HATA'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const header = (t) => Object.fromEntries(t.split('\n').map((l) => /^([a-z_]+): (.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

for (const role of ['codex', 'claude']) {
  const s = rpcSession(role);
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check(`[${role}] initialize`, init.result?.serverInfo?.name === 'clivoxa', JSON.stringify(init).slice(0, 200));
  check(`[${role}] instructions`, typeof init.result?.instructions === 'string' && init.result.instructions.includes('get_job'));
  s.notify('notifications/initialized', {});
  const list = await s.request('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const ask = role === 'codex' ? 'ask_codex' : 'ask_claude';
  check(`[${role}] tools/list`, JSON.stringify(names) === JSON.stringify([ask, 'cancel_job', 'get_job', 'list_jobs', 'list_models'].sort()), names.join(','));
  const r = await s.request('tools/call', { name: ask, arguments: { prompt: 'smoke testi', wait_seconds: 20 } });
  const t = r.result?.content?.[0]?.text ?? '';
  const h = header(t);
  check(`[${role}] tools/call ${ask}`, h.status === 'done' && !r.result?.structuredContent, t.slice(0, 300));
  const g = await s.request('tools/call', { name: 'get_job', arguments: { job_id: h.job_id } });
  check(`[${role}] get_job`, header(g.result?.content?.[0]?.text ?? '').status === 'done');
  const l = await s.request('tools/call', { name: 'list_jobs', arguments: {} });
  check(`[${role}] list_jobs`, (l.result?.content?.[0]?.text ?? '').includes(h.job_id));
  const slow = await s.request('tools/call', { name: ask, arguments: { prompt: 'uzun [[FAKE:sleep=20]]', wait_seconds: 0 } });
  const sh = header(slow.result?.content?.[0]?.text ?? '');
  check(`[${role}] async job_id`, sh.status === 'running' && !!sh.job_id);
  const c = await s.request('tools/call', { name: 'cancel_job', arguments: { job_id: sh.job_id } });
  check(`[${role}] cancel_job`, /status: (running|error)/.test(c.result?.content?.[0]?.text ?? ''));
  await s.close();
}

// Guard: a server started inside a consulted sub-agent (CLIVOXA_DEPTH set) must expose no tools.
for (const role of ['codex', 'claude']) {
  const s = rpcSession(role, { CLIVOXA_DEPTH: '1' });
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  s.notify('notifications/initialized', {});
  const list = await s.request('tools/list', {});
  check(`[${role}] döngü koruması: iç içe sunucu araç sunmaz`, Array.isArray(list.result?.tools) && list.result.tools.length === 0, JSON.stringify(list).slice(0, 200));
  await s.close();
}

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} kontrol başarısız` : '\nSmoke: tümü OK');
process.exit(failures ? 1 : 0);
