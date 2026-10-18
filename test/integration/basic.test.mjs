import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHome, startServer, argvLog, untilDone, jobDir, cleanupHome, killJobProcs } from '../helpers/harness.mjs';

const homes = [];
after(() => homes.forEach(cleanupHome));

test('role filter: codex exposes only ask_codex + job tools; claude only ask_claude', async () => {
  const h = mkHome();
  homes.push(h);
  const a = await startServer(h, 'codex');
  const c = await startServer(h, 'claude');
  try {
    assert.deepEqual((await a.tools()).map((t) => t.name).sort(), ['ask_codex', 'cancel_job', 'get_job', 'list_jobs', 'list_models']);
    assert.deepEqual((await c.tools()).map((t) => t.name).sort(), ['ask_claude', 'cancel_job', 'get_job', 'list_jobs', 'list_models']);
    const t = (await a.tools()).find((x) => x.name === 'ask_codex');
    assert.equal(t._meta?.['anthropic/alwaysLoad'], true);
    assert.equal(t.annotations?.readOnlyHint, false);
    assert.equal((await a.tools()).find((x) => x.name === 'get_job').annotations?.readOnlyHint, true);
  } finally {
    await a.close();
    await c.close();
  }
});

test('fast answer from Codex: done, session id, archive files, prompt via stdin only', async () => {
  const h = mkHome();
  homes.push(h);
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'İki artı iki kaç? --dangerously-bypass-approvals-and-sandbox', effort: 'low', wait_seconds: 30 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.h.session_id, /^[0-9a-f-]{36}$/);
    assert.ok(Number(r.h.elapsed_s.split(' ')[0]) >= 0);
    assert.match(r.h.job_dir, /\.clivoxa\/jobs\/\d{8}-\d{6}-codex-[0-9a-f]{8}$/, 'Codex job ids carry the codex name');
    assert.match(r.answer, /FAKE-CODEX effort=low mode=new/);
    assert.match(r.answer, /İki artı iki kaç\?/);
    assert.equal(r.structuredContent, undefined);
    assert.equal(r.raw.structuredContent, undefined);
    const dir = r.h.job_dir;
    for (const f of ['request.json', 'meta.json', 'prompt.md', 'answer.md', 'stderr.log', 'events.jsonl', 'result.json', 'exit_code']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.equal(fs.readFileSync(path.join(dir, 'exit_code'), 'utf8').trim(), '0');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'answer.md')).mode & 0o777, 0o600);
    const exec = argvLog(h).find((e) => e.cli === 'codex' && e.argv.includes('exec'));
    assert.ok(exec, 'codex exec was called');
    assert.ok(!exec.argv.some((x) => x.includes('İki artı')), 'prompt must never be on argv');
    assert.equal(exec.argv.at(-1), '-');
    assert.equal(exec.env.CLIVOXA_DEPTH, '1');
    assert.ok(exec.argv.includes('--ignore-rules'));
    const mcp = exec.argv.find((x) => x.startsWith('mcp_servers='));
    assert.match(mcp, /clivoxa=\{command="\/usr\/bin\/false",enabled=false\}/);
    assert.match(mcp, /kopru=\{command="\/usr\/bin\/false",enabled=false\}/);
    assert.match(mcp, /github=\{enabled=false\}/);
    assert.match(mcp, /"my\.dotted"=\{enabled=false\}/);
    assert.ok(!exec.argv.includes('-s') || exec.argv[exec.argv.indexOf('-s') + 1] === 'read-only');
    assert.ok(exec.argv.includes('shell_tool'), 'no-workdir Codex has shell tools disabled');
  } finally {
    await s.close();
  }
});

test('fast answer from Claude: stream-json argv, read-only tools, no MCP', async () => {
  const h = mkHome();
  homes.push(h);
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', { prompt: 'Merhaba Claude', model: 'sonnet', wait_seconds: 30 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.answer, /FAKE-CLAUDE model=sonnet mode=dontAsk resume=false/);
    const e = argvLog(h).find((x) => x.cli === 'claude' && x.argv.includes('-p'));
    assert.ok(e);
    assert.ok(e.argv.includes('--strict-mcp-config'));
    assert.ok(e.argv.includes('--mcp-config={"mcpServers":{}}'));
    assert.ok(e.argv.includes('--restricted'));
    assert.ok(e.argv.includes('--disable-slash-commands'));
    assert.equal(e.argv[e.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(e.argv.includes('--tools=WebSearch,WebFetch'), e.argv.join(' '));
    assert.ok(e.argv.some((x) => x.startsWith('--disallowedTools=') && x.includes('Bash') && x.includes('mcp__*') && x.includes('Edit')));
    assert.equal(e.env.CLAUDECODE, null);
    assert.equal(e.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(e.env.CLIVOXA_DEPTH, '1');
    // CLI artifacts in the scratch cwd are cleaned only for workdir jobs; scratch is ours.
  } finally {
    await s.close();
  }
});

test('long job returns job_id, then get_job; session resume continues the same session', async () => {
  const h = mkHome();
  homes.push(h);
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'yavaş [[FAKE:sleep=3]]', wait_seconds: 1 });
    assert.equal(r.h.status, 'running', r.text);
    assert.match(r.h.next_step, /get_job/);
    const d = await untilDone(s, r.h.job_id);
    assert.equal(d.h.status, 'done', d.text);
    const sid = d.h.session_id.split(' ')[0];
    const r2 = await s.call('ask_codex', { prompt: 'devam ediyoruz', session_id: sid, wait_seconds: 30 });
    assert.equal(r2.h.status, 'done', r2.text);
    assert.match(r2.h.session_id, new RegExp(`^${sid} \\(devam\\)`));
    assert.match(r2.answer, /mode=resume/);
    const resumeArgv = argvLog(h).filter((e) => e.cli === 'codex' && e.argv.includes('resume')).at(-1).argv;
    const ri = resumeArgv.indexOf('resume');
    assert.deepEqual(resumeArgv.slice(ri), ['resume', '--', sid, '-']);
    for (const rootFlag of ['-C', '--color', '-o']) assert.ok(resumeArgv.indexOf(rootFlag) < ri, `${rootFlag} before resume`);
  } finally {
    await s.close();
  }
});
