// The sandbox verifier runs Codex with a copy of the user's config.toml, so that user-level settings
// that shape the sandbox still apply. The copy lives in a directory a sub-agent may read, so anything
// that can carry a credential is left out. None of it matters for the verification: MCP servers are
// disabled for it and it talks to a local mock model with a dummy key.

/** Table paths dropped whole: MCP servers (their env and headers hold tokens) and env/header tables. */
const DROP_TABLE = (segments) =>
  segments.some((s) => /^(mcp_servers|env|http_headers|env_http_headers)$/i.test(s));
/** Keys dropped wherever they appear. */
const DROP_KEY = /(token|secret|password|passwd|api[_-]?key|bearer|authorization|cookie|credential)/i;
/** Login restrictions that would refuse the mock provider's dummy key. */
const LOGIN_KEYS = new Set(['forced_login_method', 'forced_chatgpt_workspace_id', 'preferred_auth_method']);

/** Split a dotted TOML key into its segments (bare or quoted). */
function keySegments(text) {
  const out = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** How a value that starts on this line continues: open multi-line string, or open brackets. */
function openState(value, state = { quote: null, depth: 0 }) {
  let { quote, depth } = state;
  for (let i = 0; i < value.length; i++) {
    if (quote) {
      if (quote.length === 3 && value.startsWith(quote, i)) { quote = null; i += 2; }
      else if (quote.length === 1 && value[i] === quote) quote = null;
      else if (quote === '"' && value[i] === '\\') i++;
      continue;
    }
    if (value.startsWith('"""', i) || value.startsWith("'''", i)) { quote = value.slice(i, i + 3); i += 2; continue; }
    const c = value[i];
    if (c === '#') break;
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return { quote: quote && quote.length === 3 ? quote : null, depth: Math.max(depth, 0) };
}

/**
 * The user's Codex config without anything that may hold a credential. Lines are kept or dropped
 * whole; a dropped value that spans lines is dropped with all its lines.
 */
export function sanitizedCodexConfig(text) {
  const out = [];
  let table = [];
  let dropTable = false;
  let skipping = null;
  for (const line of text.split(/\r?\n/)) {
    if (skipping) {
      skipping = openState(line, skipping);
      if (!skipping.quote && skipping.depth === 0) skipping = null;
      continue;
    }
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = keySegments(header[1]);
      dropTable = DROP_TABLE(table);
      if (!dropTable) out.push(line);
      continue;
    }
    const kv = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=(.*)$/.exec(line);
    if (!kv) {
      if (!dropTable) out.push(line);
      continue;
    }
    const key = keySegments(kv[1]);
    const full = [...table, ...key];
    const drop = dropTable || DROP_TABLE(full) || full.some((s) => DROP_KEY.test(s)) || (full.length === 1 && LOGIN_KEYS.has(full[0]));
    if (!drop) {
      out.push(line);
      continue;
    }
    const state = openState(kv[2]);
    if (state.quote || state.depth > 0) skipping = state;
  }
  return out.join('\n');
}
