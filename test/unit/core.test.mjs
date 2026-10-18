import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const D = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)));
const imp = (m) => import(pathToFileURL(path.join(D, m)).href);
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'clivoxa-unit-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));
const { redact } = await imp('shared/redact.js');
const { buildCodexArgv, buildMcpOverride, profileToml, featureFlags, redactCodexArgv } = await imp('providers/codex/argv.js');
const { buildClaudeArgv, claudeToolSets, buildClaudeSettings } = await imp('providers/claude/argv.js');
const { classify, planNext, effortRejected } = await imp('jobs/outcome.js');
const { sessionIdFromStderr, feedCodex, newCodexState } = await imp('providers/codex/events.js');
const { checkInit } = await imp('providers/claude/events.js');
const { loadConfig } = await imp('config/config.js');
const { selectionValue } = await imp('providers/models.js');
const { validateWorkdir, WorkdirError } = await imp('security/workspace.js');
const { parseFeatures, cmpVersion } = await imp('providers/capabilities.js');
const { renderJob } = await imp('mcp/render.js');
const { JOB_ID_RE, UUID_RE, newJobId, jobIdTime } = await imp('domain/ids.js');
const { composePrompt } = await imp('jobs/prompt.js');
const { buildChildEnv, filterPath } = await imp('providers/child-env.js');

function tmpHome() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, 'tu-')));
  const cfg = loadConfig({ HOME: home, CLIVOXA_HOME: path.join(home, '.clivoxa'), GIT_BIN: '/usr/bin/git' });
  return { home, cfg };
}

test('config: renamed namespace uses a separate state directory and ignores old installation settings', () => {
  const { home } = tmpHome();
  const legacyHome = path.join(home, '.kopru');
  const cfg = loadConfig({ HOME: home, KOPRU_HOME: legacyHome, KOPRU_EXPOSE: 'codex', KOPRU_MAX_ACCESS: 'write' });
  assert.equal(cfg.home, path.join(home, '.clivoxa'));
  assert.equal(cfg.expose, null, 'old role settings do not activate the renamed server');
  assert.equal(cfg.maxAccess, 'read', 'old installation permissions do not widen the new defaults');
  const explicit = loadConfig({ HOME: home, CLIVOXA_HOME: path.join(home, 'custom'), CLIVOXA_EXPOSE: 'claude', CLIVOXA_MAX_ACCESS: 'write' });
  assert.equal(explicit.home, path.join(home, 'custom'));
  assert.equal(explicit.expose, 'claude');
  assert.equal(explicit.maxAccess, 'write');
});

test('redact: high-confidence tokens, checksummed numbers, credentials; no false positives on timestamps', () => {
  const r = redact('a sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA b sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB AKIAABCDEFGHIJKLMNOP ghp_' + 'x'.repeat(36), 'high');
  assert.deepEqual(Object.keys(r.counts).sort(), ['anthropic_key', 'aws_access_key', 'github_token', 'openai_key']);
  assert.ok(!r.text.includes('sk-ant-api03'));
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redact(pem, 'high').counts.private_key, 1);
  assert.equal(redact('kart 4111 1111 1111 1111', 'all').counts.card_number, 1);
  assert.equal(redact('ts 1792017386421 ve 1792017386421123', 'all').total, 0, 'ms/us timestamps are not cards');
  assert.equal(redact('IBAN TR33 0006 1005 1978 6457 8413 26', 'all').counts.iban, 1);
  assert.equal(redact('TCKN 10000000146', 'all').counts.tckn, 1);
  assert.equal(redact('TCKN 12345678901', 'all').total, 0);
  const c = redact('password = "hunter22"\nparola: gizliSifre9', 'all');
  assert.equal(c.counts.credential, 2);
  assert.match(c.text, /password = \[GİZLİ:credential\]/);
  assert.equal(redact('kart 4111 1111 1111 1111', 'high').total, 0, 'cards are not in the high class');
});

test('codex argv: root flags before resume, -- before SID, profile vs -s exclusive, feature filtering', () => {
  const base = { access: 'read', shell: true, web: 'search', cwd: '/w', answerFile: '/j/a.md', model: 'gpt-6-astra', effort: 'high', jobId: 'J', mcpOverride: buildMcpOverride(['github']), features: { stages: { hooks: 'stable', shell_tool: 'stable', responses_websockets: 'removed' } }, allowSlashTmp: false, netOpen: false };
  const n = buildCodexArgv({ ...base, mode: 'new', sandbox: { kind: 'legacy' } });
  assert.equal(n[0], 'exec');
  assert.equal(n.at(-1), '-');
  assert.deepEqual(n.slice(n.indexOf('-s'), n.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.ok(n.includes('--disable') && n[n.indexOf('--disable') + 1] === 'hooks');
  assert.ok(!n.includes('apps'), 'features not listed by the CLI are never passed');
  const r = buildCodexArgv({ ...base, mode: 'resume', sessionId: '0190f00d-1111-7222-8333-444455556666', sandbox: { kind: 'legacy' } });
  const ri = r.indexOf('resume');
  assert.deepEqual(r.slice(ri), ['resume', '--', '0190f00d-1111-7222-8333-444455556666', '-']);
  for (const f of ['-s', '-C', '--color']) assert.ok(r.indexOf(f) < ri);
  const p = buildCodexArgv({ ...base, mode: 'new', access: 'write', sandbox: { kind: 'profiles', name: 'clivoxa_rw', toml: '{x=1}' } });
  assert.ok(!p.includes('-s'));
  assert.ok(p.includes('default_permissions="clivoxa_rw"'));
  const ns = buildCodexArgv({ ...base, mode: 'new', shell: false, sandbox: { kind: 'legacy' } });
  assert.ok(ns.includes('shell_tool'));
  assert.equal(featureFlags(['x'], null).join(' '), '--disable x', 'without caps, pass through');
  assert.match(redactCodexArgv(n).find((x) => x.startsWith('mcp_servers=')), /<3 sunucu kapatıldı>/);
});

test('mcp override: one inline table, quoted odd names, never copies commands', () => {
  const o = buildMcpOverride(['clivoxa', 'kopru', 'github', 'my.dotted', 'with space', 'github']);
  assert.equal(o, '{clivoxa={command="/usr/bin/false",enabled=false},kopru={command="/usr/bin/false",enabled=false},github={enabled=false},"my.dotted"={enabled=false},"with space"={enabled=false}}');
  assert.equal(buildMcpOverride([]), '{clivoxa={command="/usr/bin/false",enabled=false},kopru={command="/usr/bin/false",enabled=false}}', 'both bridge names are disabled even without enumeration');
});

test('profile TOML: ro/rw/git variants, protected carve-outs, secrets denied, clivoxa tmp/scratch readable', () => {
  const { cfg } = tmpHome();
  // Only existing secrets are denied (a missing deny path would become a folder on Windows).
  for (const d of ['.ssh', '.kopru', '.codex']) fs.mkdirSync(path.join(cfg.userHome, d), { recursive: true });
  fs.writeFileSync(path.join(cfg.userHome, '.codex', 'auth.json'), '{}');
  const ro = profileToml(cfg, { kind: 'ro', gitWrite: false, network: false, allowSlashTmp: false });
  assert.match(ro, /^\{extends=":read-only",filesystem=\{/);
  assert.match(ro, /\.ssh"="deny"/);
  assert.match(ro, /\.codex\/auth\.json"="deny"/);
  assert.ok(!/\.codex"="deny"/.test(ro), 'whole ~/.codex is not denied (shell snapshots)');
  assert.ok(!ro.includes('/.clivoxa/tmp"') && !ro.includes('/.clivoxa/scratch"'));
  assert.ok(ro.includes(`${JSON.stringify(path.join(cfg.userHome, '.kopru'))}="deny"`), 'legacy archives remain protected');
  assert.ok(!ro.includes(JSON.stringify(path.join(cfg.userHome, '.netrc'))), 'a missing secret path is left out');
  const rw = profileToml(cfg, { kind: 'rw', gitWrite: false, network: false, allowSlashTmp: false });
  assert.match(rw, /":slash_tmp"="read"/);
  assert.match(rw, /":workspace_roots"=\{"\."="write",".git"="read"/);
  for (const p of ['.claude', '.codex', '.agents', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.husky']) assert.ok(rw.includes(`"${p}"="read"`), p);
  assert.match(rw, /network=\{enabled=false\}/);
  const g = profileToml(cfg, { kind: 'rw', gitWrite: true, network: true, allowSlashTmp: true });
  assert.match(g, /".git"="write",".git\/hooks"="read",".git\/config"="read"/);
  assert.match(g, /network=\{enabled=true\}/);
  assert.ok(!g.includes(':slash_tmp'));
});

test('claude argv/settings: read vs write tool sets, restricted vs nosources, resume form', () => {
  const { cfg } = tmpHome();
  const i = { mode: 'new', sessionId: 'S', access: 'read', shell: false, web: 'live', network: false, gitWrite: false, cwd: '/w', tmpDir: '/t', model: 'opus', effort: 'high', jobId: 'J', agent: false, gitDirs: [], userDeny: ['Bash(rm -rf *)'], settingsFile: '/j/claude-settings.attempt1.json' };
  const a = buildClaudeArgv(i);
  assert.ok(a.includes('--restricted'));
  assert.ok(a.includes('--tools=Read,Glob,Grep,WebSearch,WebFetch'));
  assert.ok(a.includes('--session-id'));
  assert.equal(a[a.indexOf('--settings') + 1], '/j/claude-settings.attempt1.json', 'settings travel in a file, not inline');
  const s = buildClaudeSettings(cfg, i);
  assert.ok(s.permissions.deny.includes('Bash(rm -rf *)'), 'user deny rules re-applied');
  assert.equal(s.sandbox, undefined, 'no shell -> no sandbox block');
  assert.deepEqual(claudeToolSets({ access: 'write', shell: true, web: 'off', agent: false }).allowed, []);
  const w = buildClaudeArgv({ ...i, mode: 'resume', access: 'write', gitWrite: true });
  assert.ok(w.includes('--setting-sources') && w[w.indexOf('--setting-sources') + 1] === '');
  assert.ok(!w.includes('--restricted'));
  assert.equal(w.at(-1), '--resume=S');
  const ws = buildClaudeSettings(cfg, { ...i, access: 'write', gitWrite: true, network: true });
  assert.ok(ws.sandbox.filesystem.denyWrite.includes('/w/.git/hooks'));
  assert.ok(!ws.sandbox.filesystem.denyWrite.includes('/w/.git'));
  assert.ok(ws.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  assert.ok(!ws.sandbox.network.allowedDomains.includes('api.anthropic.com'));
  assert.ok(!ws.permissions.deny.some((d) => d.includes('shell-snapshots')), 'Bash shell snapshots stay readable');
});

test('classify: runner flags win; effort regex matches the literal value; Claude terminal reasons', () => {
  const base = { target: 'codex', mode: 'new', effort: 'ultra', exitCode: 0, signal: null, runnerFlag: null, answerFileText: 'ok', stderrTail: '' };
  assert.equal(classify(base).ok, true);
  assert.equal(classify({ ...base, runnerFlag: 'cancelled' }).kind, 'cancelled');
  const st = newCodexState();
  st.turnFailed = "unexpected status 400 Bad Request: Unsupported value: 'ultra' is not supported with the 'gpt-6-astra' model.";
  assert.equal(classify({ ...base, exitCode: 1, answerFileText: null, codex: st }).kind, 'effort_rejected');
  assert.equal(effortRejected("Unsupported value: 'ultra' is not supported", 'max'), false);
  const st2 = newCodexState();
  st2.turnFailed = 'unexpected status 401 Unauthorized';
  assert.equal(classify({ ...base, exitCode: 1, answerFileText: null, codex: st2 }).kind, 'auth');
  const resume = classify({ ...base, mode: 'resume', exitCode: 1, answerFileText: null, codex: newCodexState(), stderrTail: 'Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)' });
  assert.equal(resume.kind, 'resume_not_found');
  const cl = (r, extra = {}) => classify({ target: 'claude', mode: 'new', effort: 'high', exitCode: 0, signal: null, runnerFlag: null, answerFileText: null, stderrTail: '', claude: { result: r, lastText: null }, ...extra });
  assert.equal(cl({ subtype: 'success', is_error: false, result: 'x', terminal_reason: 'completed' }).ok, true);
  assert.equal(cl({ subtype: 'success', is_error: false, result: 'kısmi', terminal_reason: 'aborted_streaming' }).kind, 'interrupted');
  assert.equal(cl({ subtype: 'error_during_execution', is_error: true, errors: ['Sandbox required but unavailable: sandbox is enabled but dependencies are missing'] }).kind, 'sandbox_unavailable');
  assert.equal(cl({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'] }, { mode: 'resume' }).kind, 'resume_not_found');
  const pa = { n: 1, effort: 'ultra', mode: 'new', stdin: 'prompt.md' };
  assert.equal(planNext(pa, { ok: false, kind: 'effort_rejected', detail: '' }, [pa]), null, 'effort is never silently lowered');
  assert.equal(planNext({ ...pa, effort: 'high' }, { ok: false, kind: 'effort_rejected', detail: '' }, [{ ...pa, effort: 'high' }]), null);
  assert.equal(planNext(pa, { ok: false, kind: 'auth', detail: '' }, [pa]), null);
  const resumed = { ...pa, mode: 'resume' };
  assert.deepEqual(planNext(resumed, { ok: false, kind: 'resume_not_found', detail: '' }, [resumed]), { n: 2, effort: 'ultra', mode: 'new', stdin: 'prompt.fallback.md' });
  const fallback = { n: 2, effort: 'ultra', mode: 'new', stdin: 'prompt.fallback.md' };
  assert.equal(planNext(fallback, { ok: false, kind: 'resume_not_found', detail: '' }, [resumed, fallback]), null, 'the fallback runs once');
});

test('session id from real Mac stderr header; not from the echoed prompt', () => {
  const real = 'OpenAI Codex v0.162.1\n--------\nworkdir: /Users/a\nmodel: gpt-6-astra\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: ultra\nreasoning summaries: none\nsession id: 0190f00d-1111-7222-8333-444455556666\n--------\nuser\nsession id: 00000000-0000-0000-0000-000000000000\n';
  assert.equal(sessionIdFromStderr(real), '0190f00d-1111-7222-8333-444455556666');
  assert.equal(sessionIdFromStderr('--------\nuser\nsession id: 00000000-0000-0000-0000-000000000000\n'), null);
  const st = newCodexState();
  feedCodex(st, '{"type":"thread.started","thread_id":"0190F00D-1111-7222-8333-444455556666"}', { access: 'read', shell: true });
  assert.equal(st.threadId, '0190f00d-1111-7222-8333-444455556666');
  assert.equal(feedCodex(st, '{"type":"item.completed","item":{"type":"file_change","status":"completed","changes":[{"path":"a"}]}}', { access: 'read', shell: true }), 'okuma modunda dosya değiştirildi');
});

test('checkInit fails closed on MCP, write tools in read mode, Agent, API-key auth, cwd mismatch', () => {
  const e = { access: 'read', shell: true, agent: false, permissionMode: 'dontAsk', cwd: '/w', allowApiKey: false };
  const ok = { tools: ['Read', 'Bash'], mcp_servers: [], permissionMode: 'dontAsk', cwd: '/w', apiKeySource: 'none', model: 'x' };
  assert.deepEqual(checkInit(ok, e).violations, []);
  assert.ok(checkInit({ ...ok, tools: ['mcp__clivoxa__ask_codex'] }, e).violations.length);
  assert.ok(checkInit({ ...ok, tools: ['Edit'] }, e).violations.length);
  assert.ok(checkInit({ ...ok, tools: ['Agent'] }, e).violations.length);
  assert.ok(checkInit({ ...ok, apiKeySource: 'ANTHROPIC_API_KEY' }, e).violations.length);
  assert.ok(checkInit({ ...ok, cwd: '/other' }, e).violations.length);
  assert.ok(checkInit({ ...ok, permissionMode: 'bypassPermissions' }, e).violations.length);
  assert.ok(checkInit({ ...ok, tools: ['Bash'] }, { ...e, shell: false }).violations.length);
});

test('model identifiers are dynamic data, not model-family whitelists', () => {
  const { cfg } = tmpHome();
  for (const m of ['future-model-42', 'fable', 'opus[1m]', 'gpt-5', 'opus', 'sonnet', 'claude-opus-5-5']) assert.ok(selectionValue(m), m);
  for (const m of ['--model', 'opus; rm -rf', 'claude-opus-5-5 ', 'line\nbreak', 'nul\0byte']) assert.ok(!selectionValue(m), m);
});

test('validateWorkdir: relative, missing, file, HOME, secret dirs, symlink into secrets, metadata parts, glob', () => {
  const { home, cfg } = tmpHome();
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(home, 'file.txt'), 'x');
  fs.mkdirSync(path.join(home, '.ssh', 'k'), { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'link-ssh'));
  fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'a*b'), { recursive: true });
  const bad = (p, access = 'read') => assert.throws(() => validateWorkdir(cfg, p, access, '/nonexistent-install'), WorkdirError, p);
  bad('rel/path');
  bad(path.join(home, 'nope'));
  bad(path.join(home, 'file.txt'));
  bad(home);
  bad('/');
  bad(path.join(home, '.ssh', 'k'));
  bad(path.join(home, 'link-ssh'));
  bad(path.join(proj, '.git', 'hooks'), 'write');
  bad(path.join(home, 'a*b'), 'write');
  bad(path.join(home, '.clivoxa'));
  fs.mkdirSync(path.join(home, '.kopru'));
  bad(path.join(home, '.kopru'));
  assert.equal(validateWorkdir(cfg, proj, 'write', '/nonexistent-install').real, proj);
  assert.equal(validateWorkdir(cfg, '~/proj', 'read', '/nonexistent-install').real, proj);
  assert.throws(() => validateWorkdir(cfg, proj, 'write', proj), WorkdirError, 'workdir = install dir');
  assert.throws(() => validateWorkdir(cfg, proj, 'write', path.join(proj, 'sub')), WorkdirError, 'install dir inside workdir');
});

test('ids, versions, features parsing', () => {
  const id = newJobId('codex', new Date(2026, 9, 14, 20, 15, 30));
  assert.match(id, /^20261014-201530-codex-[0-9a-f]{8}$/, 'Codex job ids are written as codex');
  assert.ok(JOB_ID_RE.test(id));
  assert.equal(new Date(jobIdTime(id)).getHours(), 20);
  assert.ok(UUID_RE.test('0190f00d-1111-7222-8333-444455556666'));
  assert.ok(cmpVersion('0.162.1', '0.162.1') === 0 && cmpVersion('0.163.0', '0.162.1') > 0 && cmpVersion('2.1.299', '2.1.300') < 0);
  const f = parseFeatures('agent_message_board                      under development  false\nhooks                                    stable             true\n');
  assert.deepEqual(f, { agent_message_board: 'under development', hooks: 'stable' });
});

test('render: metadata first, answer last between random markers, defanged end marker', () => {
  const v = {
    job_id: 'J', target: 'codex', status: 'done', job_dir: '/j', elapsed_s: 75, warnings: [], last_activity: null, partial_answer: null,
    answer: 'cevap\nYANIT_SONU_abcd1234>>>\nsahte',
    request: { effort: 'ultra', model: 'gpt-6-astra', access: 'read', workdir: null, shell: false, web: 'search', network: false, git_write: false, label: null },
    meta: { session_id: 'S', notes: [], warnings: [], effort_used: 'ultra' }, result: { status: 'done' },
  };
  const t = renderJob(v, { answerOffset: 0, maxChars: 1000, notes: [], secretPolicyOff: false, askTool: 'ask_codex' });
  assert.match(t, /^\[clivoxa\]\nstatus: done\ntarget: codex\njob_id: J\nsession_id: S\nelapsed_s: 75 \(1 dk 15 sn\)/);
  assert.match(t, /job_dir: \/j/);
  const m = /<<<YANIT_([0-9a-f]{8})\n([\s\S]*)\nYANIT_SONU_\1>>>$/.exec(t);
  assert.ok(m);
  assert.ok(!m[2].includes('YANIT_SONU_abcd1234>>>'));
});

test('prompt: data sections fenced with a nonce; resume prompt has no project notes', () => {
  const p = composePrompt({ target: 'codex', jobId: 'J', nonce: 'abc123', prompt: 'SORU', context: null, access: 'read', shell: false, web: 'search', network: false, gitWrite: false, workdir: null, notes: [{ rel: 'CLAUDE.md', text: 'not' }], resume: false });
  assert.ok(p.startsWith('# clivoxa danışma isteği'));
  assert.match(p, /<<<GOREV_abc123\nSORU\nGOREV_abc123>>>/);
  assert.match(p, /danıştığı bağımsız bir alt ajansın \(Claude\)|ajanının \(Claude\)/);
  assert.match(p, /PROJE NOTLARI/);
  const r = composePrompt({ target: 'claude', jobId: 'J', nonce: 'x', prompt: 'S', context: 'C', access: 'write', shell: true, web: 'off', network: true, gitWrite: true, workdir: '/w', notes: [{ rel: 'a', text: 'b' }], resume: true });
  assert.ok(r.startsWith('# clivoxa danışma isteği (devam)'));
  assert.ok(!r.includes('## PROJE NOTLARI'));
  assert.match(r, /\(Codex\)/);
  assert.ok(!r.includes('GPT-'), 'the caller is named after the CLI, not a model');
  assert.match(r, /commit atabilirsin/);
});

test('child env: allowlist only, secrets and nesting markers dropped, depth markers set', () => {
  const { cfg } = tmpHome();
  const { env, dropped } = buildChildEnv(cfg, { HOME: '/h', PATH: '/x', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'tok', HTTPS_PROXY: 'http://p', RUST_LOG: 'debug' }, { target: 'claude', jobId: 'J', tmpDir: '/t', cliBin: null });
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'RUST_LOG']) assert.equal(env[k], undefined, k);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal(env.HTTPS_PROXY, 'http://p');
  assert.equal(env.CLIVOXA_DEPTH, '1');
  assert.equal(env.CLIVOXA_JOB_ID, 'J');
  assert.equal(env.KOPRU_DEPTH, '1', 'older installed servers must also reject recursion');
  assert.equal(env.KOPRU_JOB_ID, 'J');
  assert.equal(env.TMPDIR, '/t');
  assert.equal(env.CLAUDE_CODE_TMPDIR, '/t');
  assert.ok(dropped.includes('ANTHROPIC_API_KEY'));
  // Claude's login never reaches a Codex child, whose shell could print it.
  const codexEnv = buildChildEnv(cfg, { HOME: '/h', PATH: '/x', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://x', HTTPS_PROXY: 'http://p' }, { target: 'codex', jobId: 'J', tmpDir: '/t', cliBin: null }).env;
  assert.equal(codexEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(codexEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(codexEnv.HTTPS_PROXY, 'http://p');
  const dir = fs.mkdtempSync(path.join(BASE, 'fp-'));
  fs.chmodSync(dir, 0o777);
  assert.deepEqual(filterPath(['', '.', 'rel', dir, '/usr/bin']), ['/usr/bin']);
  // Homebrew on an admin Mac: /opt/homebrew/bin is 775 user:admin (gid 80) and must stay.
  if (process.getuid?.() === 0) {
    const brew = fs.mkdtempSync(path.join(BASE, 'brew-'));
    fs.chmodSync(brew, 0o775);
    fs.chownSync(brew, 0, 80);
    assert.deepEqual(filterPath([brew], 'darwin'), [brew]);
    assert.deepEqual(filterPath([brew], 'linux'), [], 'group-writable is only trusted for the macOS admin group');
    fs.chmodSync(brew, 0o777);
    assert.deepEqual(filterPath([brew], 'darwin'), [], 'world-writable never');
  }
});
