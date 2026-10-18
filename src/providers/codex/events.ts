import { UUID_RE } from '../../domain/ids.js';

export interface CodexState {
  threadId: string | null;
  lastAgentMessage: string | null;
  turnFailed: string | null;
  turnCompleted: boolean;
  errors: string[];
  fileChanges: { path: string; kind?: string; status?: string }[];
  commands: number;
  mcpCalls: number;
  events: number;
  lastActivity: string | null;
  usage: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number } | null;
  violations: string[];
}

export interface CodexCheck {
  access: 'read' | 'write';
  shell: boolean;
}

export function newCodexState(): CodexState {
  return {
    threadId: null, lastAgentMessage: null, turnFailed: null, turnCompleted: false, errors: [], fileChanges: [],
    commands: 0, mcpCalls: 0, events: 0, lastActivity: null, usage: null, violations: [],
  };
}

function short(s: unknown, n = 120): string {
  const t = typeof s === 'string' ? s : Array.isArray(s) ? s.join(' ') : JSON.stringify(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Feed one stdout JSONL line from `codex exec --json`. Returns a violation string if a self-check failed. */
export function feedCodex(st: CodexState, line: string, chk: CodexCheck): string | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  st.events++;
  const type = ev.type;
  if (type === 'thread.started') {
    const id = typeof ev.thread_id === 'string' ? ev.thread_id.toLowerCase() : '';
    if (!st.threadId && UUID_RE.test(id)) st.threadId = id;
    return null;
  }
  if (type === 'turn.failed') {
    const e = ev.error as { message?: string } | undefined;
    st.turnFailed = e?.message ?? 'turn failed';
    return null;
  }
  if (type === 'turn.completed') {
    st.turnCompleted = true;
    const u = ev.usage as Record<string, number> | undefined;
    if (u) st.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, reasoning_tokens: u.reasoning_output_tokens };
    return null;
  }
  if (type === 'error') {
    if (typeof ev.message === 'string') st.errors.push(ev.message.slice(0, 2000));
    if (st.errors.length > 50) st.errors.splice(0, st.errors.length - 50);
    return null;
  }
  if (typeof type === 'string' && type.startsWith('item.')) {
    const item = ev.item as Record<string, unknown> | undefined;
    if (!item) return null;
    const it = item.type;
    const completed = type === 'item.completed';
    switch (it) {
      case 'agent_message':
        if (completed && typeof item.text === 'string') st.lastAgentMessage = item.text;
        st.lastActivity = 'yanıt yazıyor';
        break;
      case 'reasoning':
        st.lastActivity = 'düşünüyor';
        break;
      case 'command_execution':
        if (type === 'item.started') st.commands++;
        st.lastActivity = `komut: ${short(item.command)}`;
        if (!chk.shell) return 'kabuk kapalıyken komut çalıştırıldı';
        break;
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : [];
        if (completed) for (const c of changes) if (c?.path) st.fileChanges.push({ path: c.path, kind: c.kind, status: String(item.status ?? '') });
        st.lastActivity = `dosya değişikliği: ${short(changes.map((c) => c?.path).join(', '))}`;
        if (chk.access === 'read' && completed && item.status === 'completed') return 'okuma modunda dosya değiştirildi';
        break;
      }
      case 'mcp_tool_call':
        st.mcpCalls++;
        return `MCP aracı çağrıldı (${short(`${String(item.server ?? '?')}.${String(item.tool ?? '?')}`, 60)})`;
      case 'collab_tool_call':
        st.lastActivity = 'alt ajanlarla çalışıyor';
        break;
      case 'web_search':
        st.lastActivity = `web araması: ${short(item.query ?? '')}`;
        break;
      case 'todo_list':
        st.lastActivity = 'plan güncelliyor';
        break;
      case 'error':
        if (typeof item.message === 'string' && !/Falling back from WebSockets/i.test(item.message)) st.errors.push(item.message.slice(0, 2000));
        break;
      default:
        break;
    }
  }
  return null;
}

/** Fallback session-id extraction from human-mode stderr (only before the prompt echo). */
export function sessionIdFromStderr(stderr: string): string | null {
  const clean = stderr.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // The prompt is echoed right after a "--------\nuser" line; never look past it.
  const echo = /^--------\r?\nuser\r?$/m.exec(clean);
  const head = echo ? clean.slice(0, echo.index) : clean.slice(0, 4000);
  const m = /^session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}
