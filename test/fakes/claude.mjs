#!/usr/bin/env node
// Fake `claude` CLI (2.1.300 surface used by clivoxa): --version | -p --output-format stream-json …
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_ARGV_LOG;
if (argv.includes('--input-format')) {
  const models = JSON.parse(process.env.FAKE_MODELS ?? JSON.stringify(['default','opus','sonnet','haiku'].map(value => ({value, displayName:value, supportedEffortLevels:['low','medium','high','xhigh','max']}))));
  readline.createInterface({input:process.stdin}).on('line', line => {
    const q=JSON.parse(line);
    if(q.type==='control_request') console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:q.request_id,response:{models}}}));
  });
  await new Promise(resolve => process.stdin.once('end', resolve));
  process.exit(0);
}
// Like the real CLI, --settings takes a JSON string or a file path; the log records what it carried.
const settingsArg = argv[argv.indexOf('--settings') + 1];
const settings = !argv.includes('--settings') ? null : settingsArg.trimStart().startsWith('{') ? JSON.parse(settingsArg) : JSON.parse(fs.readFileSync(settingsArg, 'utf8'));
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ cli: 'claude', cwd: process.cwd(), argv, settings, env: { CLIVOXA_DEPTH: process.env.CLIVOXA_DEPTH, TMPDIR: process.env.TMPDIR, CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR, CLAUDECODE: process.env.CLAUDECODE ?? null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS } }) + '\n');

if (argv.includes('--version')) {
  console.log('2.1.300 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
  process.exit(0);
}
if (argv[0] === 'mcp') {
  const cj = path.join(process.env.HOME || '/tmp', '.claude.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { j = {}; }
  j.mcpServers ??= {};
  const nameAt = (i) => argv.filter((a, k) => k >= i && !a.startsWith('-') && argv[k - 1] !== '-s')[0];
  if (argv[1] === 'add-json') {
    const name = nameAt(2);
    j.mcpServers[name] = JSON.parse(argv.at(-1));
    fs.writeFileSync(cj, JSON.stringify(j, null, 2));
    console.log(`Added stdio MCP server ${name} to user config`);
    process.exit(0);
  }
  if (argv[1] === 'remove') {
    const name = nameAt(2);
    if (!j.mcpServers[name]) { console.error(`No MCP server found with name: ${name}`); process.exit(1); }
    delete j.mcpServers[name];
    fs.writeFileSync(cj, JSON.stringify(j, null, 2));
    process.exit(0);
  }
  if (argv[1] === 'get') {
    const e = j.mcpServers[argv[2]];
    if (!e) { console.error(`No MCP server found with name: ${argv[2]}`); process.exit(1); }
    console.log(`${argv[2]}:\n  Scope: User config\n  Type: stdio\n  Command: ${e.command}\n  Args: ${(e.args ?? []).join(' ')}`);
    process.exit(0);
  }
  if (argv[1] === 'list') {
    for (const n of Object.keys(j.mcpServers)) console.log(`${n}: ${j.mcpServers[n].command} - ✓ Connected`);
    process.exit(0);
  }
}
const val = (flag) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
  }
  return null;
};
const store = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/tmp', '.claude'), 'fake-sessions.json');
const sessions = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return []; } };
const resume = val('--resume');
const sid = resume ?? val('--session-id');
const tools = (val('--tools') ?? '').split(',').filter(Boolean);
const mode = val('--permission-mode');
const model = val('--model');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString('utf8')));
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const marker = (p, n) => { const m = new RegExp(`\\[\\[FAKE:${n}(?:=([^\\]]*))?\\]\\]`).exec(p); return m ? (m[1] ?? '') : null; };

async function main(prompt) {
  const initTools = [...tools];
  if (marker(prompt, 'init_agent') !== null) initTools.push('Agent');
  if (marker(prompt, 'bad_init') === 'bash') initTools.push('Bash');
  if (marker(prompt, 'init_mcp') !== null) initTools.push('mcp__clivoxa__ask_codex');
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: initTools, mcp_servers: [], model, permissionMode: mode, apiKeySource: 'none', skills: [], slash_commands: [] });
  if (resume && !sessions().includes(resume)) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resume, num_turns: 0, errors: [`No conversation found with session ID: ${resume}`] });
    console.error(`No conversation found with session ID: ${resume}`);
    process.exit(1);
  }
  if (marker(prompt, 'auth_fail') !== null) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: sid, terminal_reason: 'completed' });
    process.exit(1);
  }
  let interrupted = false;
  const sigintResult = marker(prompt, 'sigint_result') !== null;
  process.on('SIGINT', () => {
    interrupted = true;
    if (sigintResult) {
      emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', result: 'kısmi', session_id: sid });
      process.exit(0);
    }
  });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }] } });
  const wf = marker(prompt, 'write_file');
  if (wf) fs.writeFileSync(path.join(process.cwd(), wf), 'written by fake claude\n');
  for (const m of prompt.matchAll(/\[\[FAKE:(plant|big_plant)=([^\]]*)\]\]/g)) {
    const p = path.join(process.cwd(), m[2]);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, m[1] === 'big_plant' ? 'B'.repeat(2 * 1024 * 1024) : 'planted\n');
  }
  fs.mkdirSync(path.join(process.cwd(), '.claude', '.cc-writes'), { recursive: true });
  const sleepS = Number(marker(prompt, 'sleep') ?? 0);
  const t0 = Date.now();
  while (Date.now() - t0 < sleepS * 1000 && !interrupted) await new Promise((r) => setTimeout(r, 50));
  if (interrupted) process.exit(130);
  const gorev = /<<<GOREV_[0-9a-f]+\n([\s\S]*?)\nGOREV_/.exec(prompt)?.[1] ?? prompt;
  const text = `FAKE-CLAUDE model=${model} mode=${mode} resume=${!!resume} cwd=${process.cwd()}\n${gorev.replace(/\[\[FAKE:[^\]]*\]\]/g, '').trim().slice(0, 300)}`;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  if (!resume) fs.mkdirSync(path.dirname(store), { recursive: true }), fs.writeFileSync(store, JSON.stringify([...sessions(), sid]));
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, terminal_reason: 'completed', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: marker(prompt, 'denial') !== null ? [{ tool_name: 'Bash', tool_input: { command: 'curl evil' } }] : [] });
  process.exit(0);
}
