import { caseFold } from '../../system/paths.js';

export interface ClaudeInit {
  tools: string[];
  mcp_servers: unknown[];
  permissionMode: string;
  cwd: string;
  apiKeySource: string;
  model: string;
}

export interface ClaudeResult {
  subtype: string;
  is_error: boolean;
  result?: string;
  session_id?: string;
  terminal_reason?: string;
  errors?: string[];
  permission_denials?: { tool_name: string; tool_input?: unknown }[];
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
}

export interface ClaudeState {
  init: ClaudeInit | null;
  result: ClaudeResult | null;
  lastText: string | null;
  events: number;
  lastActivity: string | null;
  violations: string[];
  initWarnings: string[];
}

export interface ClaudeExpected {
  access: 'read' | 'write';
  shell: boolean;
  agent: boolean;
  permissionMode: string;
  cwd: string;
  allowApiKey: boolean;
}

export function newClaudeState(): ClaudeState {
  return { init: null, result: null, lastText: null, events: 0, lastActivity: null, violations: [], initWarnings: [] };
}

/** Pure init self-check. Returns violations (fail closed) and warnings. */
export function checkInit(init: ClaudeInit, e: ClaudeExpected): { violations: string[]; warnings: string[] } {
  const v: string[] = [];
  const w: string[] = [];
  const tools = Array.isArray(init.tools) ? init.tools : [];
  if (tools.some((t) => t.startsWith('mcp__'))) v.push('MCP aracı görünüyor');
  if (Array.isArray(init.mcp_servers) && init.mcp_servers.length > 0) v.push('MCP sunucusu bağlı');
  if (e.access === 'read' && tools.some((t) => ['Edit', 'Write', 'NotebookEdit', 'PowerShell'].includes(t))) v.push('okuma modunda yazma aracı var');
  if (!e.shell && e.access === 'read' && tools.includes('Bash')) v.push('kabuk kapalıyken Bash var');
  if (!e.agent && tools.includes('Agent')) v.push('Agent aracı var');
  if (init.permissionMode && init.permissionMode !== e.permissionMode) v.push(`izin modu beklenmedik: ${init.permissionMode}`);
  if (!e.allowApiKey && ['ANTHROPIC_API_KEY', 'apiKeyHelper'].includes(init.apiKeySource)) v.push(`API anahtarı ile kimlik doğrulama (${init.apiKeySource})`);
  if (init.cwd && caseFold(init.cwd) !== caseFold(e.cwd)) v.push('cwd beklenmedik');
  return { violations: v, warnings: w };
}

/** Feed one stdout line of `claude -p --output-format stream-json --verbose`. Returns a violation if any. */
export function feedClaude(st: ClaudeState, line: string, e: ClaudeExpected): string | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  st.events++;
  if (ev.type === 'system' && ev.subtype === 'init' && !st.init) {
    st.init = {
      tools: Array.isArray(ev.tools) ? (ev.tools as string[]) : [],
      mcp_servers: Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as unknown[]) : [],
      permissionMode: String(ev.permissionMode ?? ''),
      cwd: String(ev.cwd ?? ''),
      apiKeySource: String(ev.apiKeySource ?? ''),
      model: String(ev.model ?? ''),
    };
    const r = checkInit(st.init, e);
    st.initWarnings.push(...r.warnings);
    if (r.violations.length) {
      st.violations.push(...r.violations);
      return r.violations.join('; ');
    }
    st.lastActivity = 'başladı';
    return null;
  }
  if (ev.type === 'assistant') {
    const m = ev.message as { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
    for (const c of m?.content ?? []) {
      if (c.type === 'text' && c.text) {
        st.lastText = c.text;
        st.lastActivity = 'yanıt yazıyor';
      } else if (c.type === 'tool_use') {
        const detail = c.name === 'Bash' ? String(c.input?.command ?? '').slice(0, 120) : String(c.input?.file_path ?? c.input?.pattern ?? c.input?.url ?? c.input?.query ?? '').slice(0, 120);
        st.lastActivity = `araç: ${c.name}${detail ? ` ${detail}` : ''}`;
        if (typeof c.name === 'string' && c.name.startsWith('mcp__')) {
          st.violations.push('MCP aracı çağrıldı');
          return 'MCP aracı çağrıldı';
        }
      } else if (c.type === 'thinking') {
        st.lastActivity = 'düşünüyor';
      }
    }
    return null;
  }
  if (ev.type === 'result') {
    st.result = {
      subtype: String(ev.subtype ?? ''),
      is_error: ev.is_error === true,
      result: typeof ev.result === 'string' ? ev.result : undefined,
      session_id: typeof ev.session_id === 'string' ? ev.session_id : undefined,
      terminal_reason: typeof ev.terminal_reason === 'string' ? ev.terminal_reason : undefined,
      errors: Array.isArray(ev.errors) ? (ev.errors as unknown[]).map(String) : undefined,
      permission_denials: Array.isArray(ev.permission_denials) ? (ev.permission_denials as ClaudeResult['permission_denials']) : undefined,
      total_cost_usd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
      usage: (ev.usage as ClaudeResult['usage']) ?? undefined,
      num_turns: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
    };
  }
  return null;
}
