import path from 'node:path';
import { readTextSafe } from '../../system/fs.js';

/**
 * The model and reasoning effort Codex falls back to when a request names none: the top-level
 * `model` and `model_reasoning_effort` keys of CODEX_HOME/config.toml. Codex does not report the
 * model it used in `exec --json`, so this is how a result can say which one answered. Only those keys
 * and `profile` are read; nothing else in the file (MCP servers, tokens) is parsed or kept. A selected
 * profile has its own model, which is not guessed: the result then says "unknown".
 */
export function codexDefaults(codexHome: string): { model?: string; effort?: string } {
  const text = readTextSafe(path.join(codexHome, 'config.toml'));
  if (!text) return {};
  // Top-level keys end where the first table starts (any line opening with "[" ends it, never later).
  const top = text.split(/^\s*\[/m)[0] ?? '';
  if (/^\s*profile\s*=/m.test(top)) return {};
  const key = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}\\s*=\\s*"([^"\\r\\n]{1,200})"\\s*(?:#.*)?$`, 'm').exec(top)?.[1];
  const model = key('model');
  const effort = key('model_reasoning_effort');
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
