// Mock model servers used by contract tests and `doctor --verify`.
// They let the REAL codex / claude binaries run a full turn offline, at zero cost:
//   codex:  CODEX_API_KEY=dummy  -c openai_base_url="http://127.0.0.1:<port>/v1"
//   claude: ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
// SSE shapes follow codex-rs/core/tests/common/responses.rs (rust-v0.162.1) and the
// Anthropic Messages streaming format.
import http from 'node:http';

function sseFrame(ev) {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Start a mock OpenAI Responses server.
 * `script` is called for every POST .../responses with ({body, index}) and returns
 * either {text}, {exec: "<shell command>"} (asks codex to run a command via its exec tool),
 * {error: {status, body}} or {raw: "<sse string>"}.
 */
export async function startMockResponses(script) {
  const requests = [];
  let respCounter = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ method: req.method, url: req.url, body });
    if (req.method === 'GET' && /\/models/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], models: [] }));
      return;
    }
    if (req.method !== 'POST' || !/\/responses/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const index = requests.filter((r) => r.method === 'POST' && /\/responses/.test(r.url ?? '')).length - 1;
    const step = (await script({ body, index })) ?? { text: 'tamam' };
    if (step.error) {
      res.writeHead(step.error.status ?? 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(step.error.body ?? { error: { message: 'mock error' } }));
      return;
    }
    const id = `resp_${++respCounter}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (step.raw) { res.end(step.raw); return; }
    const evs = [{ type: 'response.created', response: { id } }];
    if (step.js !== undefined) {
      // gpt-6-astra runs in "code mode": one freeform `exec` tool evaluates JavaScript that
      // calls nested tools, e.g. `await tools.exec_command({cmd})`.
      evs.push({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', input: step.js, call_id: `call_${respCounter}` } });
    } else if (step.exec !== undefined) {
      const toolName = step.toolName ?? pickExecTool(body);
      const args = toolName === 'shell' ? { command: ['bash', '-lc', step.exec] } : { cmd: step.exec };
      evs.push({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_${respCounter}`, name: toolName, arguments: JSON.stringify(args) } });
    } else if (step.patch !== undefined) {
      evs.push({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'apply_patch', input: step.patch, call_id: `call_${respCounter}` } });
    } else {
      evs.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${respCounter}`, content: [{ type: 'output_text', text: step.text ?? 'tamam' }] } });
    }
    evs.push({ type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
    res.end(evs.map(sseFrame).join(''));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Find the exec tool name codex advertised in the request ("exec_command" or "shell"). */
export function pickExecTool(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const names = tools.map((t) => t?.name ?? t?.function?.name).filter(Boolean);
  if (names.includes('exec_command')) return 'exec_command';
  if (names.includes('shell')) return 'shell';
  return names.find((n) => /exec|shell/.test(n)) ?? 'exec_command';
}

/** Names of all tools advertised in a Responses request body (incl. namespaced ones). */
export function toolNames(body) {
  const out = [];
  const walk = (t) => {
    if (!t || typeof t !== 'object') return;
    const n = t.name ?? t.function?.name ?? t.type;
    if (n) out.push(t.namespace ? `${t.namespace}.${n}` : n);
    if (Array.isArray(t.tools)) t.tools.forEach(walk);
  };
  (Array.isArray(body?.tools) ? body.tools : []).forEach(walk);
  return out;
}

/** Extract function_call_output payloads from a Responses request body. */
export function functionOutputs(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.filter((i) => i?.type === 'function_call_output' || i?.type === 'custom_tool_call_output').map((i) => i.output);
}

/**
 * Start a mock Anthropic Messages server (streaming).
 * `script({body, index})` returns {text} or {toolUse: {name, input}}.
 */
export async function startMockMessages(script) {
  const requests = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const url = req.url ?? '';
    if (req.method === 'POST' && /\/v1\/messages\/count_tokens/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (req.method !== 'POST' || !/\/v1\/messages/.test(url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
      return;
    }
    const index = requests.filter((r) => r.method === 'POST' && /\/v1\/messages(\?|$)/.test(r.url ?? '')).length - 1;
    const step = (await script({ body, index })) ?? { text: 'tamam' };
    const id = `msg_${++n}`;
    const model = body?.model ?? 'claude-mock';
    const stream = body?.stream === true;
    const content = step.toolUse
      ? [{ type: 'tool_use', id: `toolu_${n}`, name: step.toolUse.name, input: step.toolUse.input }]
      : [{ type: 'text', text: step.text ?? 'tamam' }];
    const stop = step.toolUse ? 'tool_use' : 'end_turn';
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frames = [];
    const f = (type, data) => frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    f('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    content.forEach((c, i) => {
      if (c.type === 'text') {
        f('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        f('content_block_delta', { index: i, delta: { type: 'text_delta', text: c.text } });
      } else {
        f('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
        f('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
      }
      f('content_block_stop', { index: i });
    });
    f('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    f('message_stop', {});
    res.end(frames.join(''));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
