import { redact } from './redact.js';

let level: 'info' | 'debug' = 'info';

export function setLogLevel(l: 'info' | 'debug'): void {
  level = l;
}

/** Log to stderr (MCP stdio servers must never write logs to stdout). Secrets are masked. */
export function log(msg: string, extra?: Record<string, unknown>): void {
  const line = `[clivoxa ${new Date().toISOString()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  process.stderr.write(redact(line, 'all').text + '\n');
}

export function debug(msg: string, extra?: Record<string, unknown>): void {
  if (level === 'debug') log(msg, extra);
}
