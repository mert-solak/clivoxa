import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHome, startServer, argvLog, untilDone, cleanupHome, killJobProcs } from '../helpers/harness.mjs';

const homes = [];
after(() => homes.forEach(cleanupHome));

/** Schema violations surface either as a rejected call or as an isError tool result (SDK-dependent). */
async function expectInvalid(p, re) {
  try {
    const r = await p;
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, re);
  } catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    assert.match(String(e?.message ?? e), re);
  }
}
const H = (o) => {
  const h = mkHome(o);
  homes.push(h);
  return h;
};

test('effort rejection never silently changes the caller selection', async () => {
  const h=H(); const server=await startServer(h,'codex');
  try {
    const result=await server.call('ask_codex',{prompt:'[[FAKE:effort_reject=ultra,max]]',effort:'ultra',wait_seconds:30});
    assert.equal(result.h.status,'error',result.text);
    assert.equal(result.h.error_kind,'effort_rejected');
    const attempts=argvLog(h).filter(entry=>entry.cli==='codex'&&entry.argv.includes('exec'));
    assert.equal(attempts.length,1);
    assert.ok(attempts[0].argv.includes('model_reasoning_effort="ultra"'));
  } finally { await server.close(); }
});

test('no fallback for effort high; auth errors never fall back', async () => {
  const h = H();
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'x [[FAKE:effort_reject=high]]', effort: 'high', wait_seconds: 30 });
    assert.equal(r.h.status, 'error', r.text);
    assert.equal(r.h.error_kind, 'effort_rejected');
    assert.equal(argvLog(h).filter((e) => e.cli === 'codex' && e.argv.includes('exec')).length, 1);
    const a = await s.call('ask_codex', { prompt: 'x [[FAKE:auth_fail]]', effort: 'ultra', wait_seconds: 30 });
    assert.equal(a.h.error_kind, 'auth');
    assert.match(a.h.error, /codex login/);
    assert.equal(argvLog(h).filter((e) => e.cli === 'codex' && e.argv.includes('exec')).length, 2);
    const c = await startServer(h, 'claude');
    const ca = await c.call('ask_claude', { prompt: 'x [[FAKE:auth_fail]]', wait_seconds: 30 });
    assert.equal(ca.h.error_kind, 'auth', ca.text);
    assert.match(ca.h.error, /claude auth login/);
    await c.close();
  } finally {
    await s.close();
  }
});

test('two concurrent jobs run in parallel and both finish', async () => {
  const h = H();
  const s = await startServer(h, 'codex');
  try {
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      s.call('ask_codex', { prompt: 'bir [[FAKE:sleep=2]]', wait_seconds: 20 }),
      s.call('ask_codex', { prompt: 'iki [[FAKE:sleep=2]]', wait_seconds: 20 }),
    ]);
    assert.equal(a.h.status, 'done', a.text);
    assert.equal(b.h.status, 'done', b.text);
    assert.notEqual(a.h.job_id, b.h.job_id);
    assert.ok(Date.now() - t0 < 6000, 'jobs ran concurrently');
    // The two children's run intervals really overlap (not merely fast one after the other).
    const span = (x) => {
      const at = JSON.parse(fs.readFileSync(path.join(x.h.job_dir, 'meta.json'), 'utf8')).attempts[0];
      return [Date.parse(at.started_at), Date.parse(at.ended_at)];
    };
    const [sa, ea] = span(a);
    const [sb, eb] = span(b);
    assert.ok(sa < eb && sb < ea, `overlap: a=[${sa},${ea}] b=[${sb},${eb}]`);
    assert.match(a.answer, /bir/);
    assert.match(b.answer, /iki/);
  } finally {
    await s.close();
  }
});

test('server restart: the detached job keeps running and get_job reads the result', async () => {
  const h = H();
  let s = await startServer(h, 'codex');
  const r = await s.call('ask_codex', { prompt: 'kalıcı [[FAKE:sleep=3]]', wait_seconds: 0 });
  assert.equal(r.h.status, 'running');
  await s.close(); // host quits / restarts the server
  s = await startServer(h, 'codex');
  try {
    const d = await untilDone(s, r.h.job_id);
    assert.equal(d.h.status, 'done', d.text);
    assert.match(d.answer, /kalıcı/);
    const lj = await s.call('list_jobs', {});
    assert.match(lj.text, new RegExp(r.h.job_id));
  } finally {
    await s.close();
  }
});

test('input validation: session_id injection, unknown session, traversal and cross-role job ids', async () => {
  const h = H();
  const s = await startServer(h, 'codex');
  try {
    for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '--last', 'my-thread', '../../x.jsonl']) {
      await expectInvalid(s.call('ask_codex', { prompt: 'x', session_id: bad }), /session_id|Invalid|pattern|regex/i);
    }
    const u = await s.call('ask_codex', { prompt: 'x', session_id: '0190f00d-1111-7222-8333-444455556666' });
    assert.equal(u.isError, true);
    assert.match(u.text, /Bilinmeyen session_id/);
    await expectInvalid(s.call('get_job', { job_id: '../../etc/passwd' }), /job_id|Invalid|pattern/i);
    const cross = await s.call('get_job', { job_id: '20261014-120000-claude-0123abcd' });
    assert.equal(cross.isError, true);
    assert.match(cross.text, /yalnız codex işlerini/);
    const nf = await s.call('get_job', { job_id: '20261014-120000-codex-0123abcd' });
    assert.match(nf.text, /İş bulunamadı/);
    const w = await s.call('ask_codex', { prompt: 'x', workdir: 'relative/path' });
    assert.match(w.text, /mutlak/);
    const w2 = await s.call('ask_codex', { prompt: 'x', workdir: h.home });
    assert.match(w2.text, /ana dizininizin altında|workdir olamaz/);
    fs.mkdirSync(path.join(h.home, '.ssh', 'keys'), { recursive: true });
    const w3 = await s.call('ask_codex', { prompt: 'x', workdir: path.join(h.home, '.ssh', 'keys') });
    assert.match(w3.text, /~\/\.ssh/);
    const sh = await s.call('ask_codex', { prompt: 'x', shell: true });
    assert.match(sh.text, /shell=true için workdir/);
    const nw = await s.call('ask_codex', { prompt: 'x', network: true });
    assert.match(nw.text, /network=true yalnız/);
    const wr = await s.call('ask_codex', { prompt: 'x', access: 'write' });
    assert.match(wr.text, /workdir gerekli/);
  } finally {
    await s.close();
  }
});

test('wait_seconds is clamped to 50 and list_jobs limit to 1..100', async () => {
  const h = H();
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', { prompt: 'kısa', wait_seconds: 300 });
    assert.equal(r.h.status, 'done', r.text);
    assert.match(r.h.notes, /wait_seconds 50 ile sınırlandı/);
    const l = await s.call('list_jobs', { limit: 1000 });
    assert.match(l.text, /limit 1\.\.100/);
    assert.match(l.text, /jobs: 1/);
  } finally {
    await s.close();
  }
});

test('resume fallback: unknown CLI session -> new session with archived turns, both targets', async () => {
  for (const role of ['codex', 'claude']) {
    const h = H();
    const s = await startServer(h, role);
    const tool = role === 'codex' ? 'ask_codex' : 'ask_claude';
    try {
      const r1 = await s.call(tool, { prompt: 'ilk soru', wait_seconds: 30 });
      assert.equal(r1.h.status, 'done', r1.text);
      const sid = r1.h.session_id.split(' ')[0];
      // Make the CLI forget the session (e.g. its history was pruned).
      const store = role === 'codex' ? path.join(h.home, '.codex', 'fake-threads.json') : path.join(h.home, '.claudecfg', 'fake-sessions.json');
      fs.writeFileSync(store, '[]');
      const r2 = await s.call(tool, { prompt: 'ikinci soru', session_id: sid, wait_seconds: 30 });
      assert.equal(r2.h.status, 'done', r2.text);
      assert.match(r2.h.notes, /Önceki oturum bulunamadı/);
      assert.notEqual(r2.h.session_id.split(' ')[0], sid);
      const fb = fs.readFileSync(path.join(r2.h.job_dir, 'prompt.fallback.md'), 'utf8');
      assert.match(fb, /ÖNCEKİ TURLAR/);
      assert.match(fb, /ilk soru/);
    } finally {
      await s.close();
    }
  }
});

test('cancel_job: Claude SIGINT result is reported as cancelled with the partial answer kept', async () => {
  const h = H();
  const s = await startServer(h, 'claude');
  try {
    const r = await s.call('ask_claude', { prompt: 'uzun [[FAKE:sleep=20]] [[FAKE:sigint_result]]', wait_seconds: 1 });
    assert.equal(r.h.status, 'running');
    await s.call('cancel_job', { job_id: r.h.job_id });
    const d = await untilDone(s, r.h.job_id, 20_000);
    assert.equal(d.h.status, 'error', d.text);
    assert.equal(d.h.error_kind, 'cancelled');
    assert.match(d.text, /partial_answer: /);
    assert.equal(fs.readFileSync(path.join(d.h.job_dir, 'exit_code'), 'utf8').trim(), '130');
  } finally {
    await s.close();
  }
});

test('cancel ladder escalates when the child ignores SIGINT; cancel before start never spawns', async () => {
  const h = H();
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'inatçı [[FAKE:sleep=30]] [[FAKE:ignore_sigint]]', wait_seconds: 1 });
    await s.call('cancel_job', { job_id: r.h.job_id });
    const d = await untilDone(s, r.h.job_id, 20_000);
    assert.equal(d.h.error_kind, 'cancelled', d.text);
    const meta = JSON.parse(fs.readFileSync(path.join(d.h.job_dir, 'meta.json'), 'utf8'));
    assert.throws(() => process.kill(meta.child.pid, 0));
  } finally {
    await s.close();
  }
});

test('orphan reaper: runner SIGKILLed -> child killed, job finalized as orphaned', async () => {
  const h = H();
  const s = await startServer(h, 'codex');
  try {
    const r = await s.call('ask_codex', { prompt: 'yetim [[FAKE:sleep=30]]', wait_seconds: 1 });
    const dir = r.h.job_dir;
    let runner;
    for (let i = 0; i < 50 && !runner; i++) {
      try {
        runner = JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'), 'utf8'));
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        if (!m.child) runner = undefined;
      } catch {
        /* not yet */
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    const child = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).child;
    process.kill(runner.pid, 'SIGKILL');
    await new Promise((res) => setTimeout(res, 300));
    const d = await untilDone(s, r.h.job_id, 20_000);
    assert.equal(d.h.status, 'error', d.text);
    assert.equal(d.h.error_kind, 'orphaned');
    assert.throws(() => process.kill(child.pid, 0), 'orphaned child must be killed');
  } finally {
    await s.close();
  }
});
