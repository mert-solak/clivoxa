import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { layout, type Config } from '../config/config.js';
import { VERSION } from '../shared/version.js';
import type { Target } from '../domain/ids.js';
import { binFingerprint } from './capabilities.js';
import { buildChildEnv, resolveLaunch } from './child-env.js';
import { codexBaseUrlArgs } from './codex/argv.js';
import { signalAll } from '../system/platform/index.js';
import { ensureDir0700 } from '../system/fs.js';

export interface ModelInfo {
  id: string;
  displayName: string;
  resolvedModel?: string;
  efforts: string[] | null;
  defaultEffort?: string;
  isDefault: boolean;
}
export interface ModelCatalogue {
  target: Target;
  source: 'codex/app-server/model/list' | 'claude/control/initialize';
  observedAt: string;
  sourceFreshness: 'unknown';
  accessVerified: false;
  models: ModelInfo[];
}
export function selectionValue(value: string, max = 256): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x20\x7f]/.test(value) && !value.startsWith('-');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI kontrol protokolü beklenmeyen veri döndürdü.');
  return value as Record<string, unknown>;
}
function stringValues(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as unknown[]).filter((entry): entry is string => typeof entry === 'string' && selectionValue(entry)) : null;
}

/** Short-lived control session. No user message or inference request is ever sent. */
class ControlSession {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private bytes = 0;
  private closed = false;
  private exited = false;
  private timer: NodeJS.Timeout;
  private ended: Promise<void>;
  constructor(cfg: Config, target: Target, cwd: string) {
    const bin = cfg.bins[target];
    if (!bin) throw new Error(`${target === 'codex' ? 'Codex' : 'Claude'} CLI bulunamadı. CLI'ı kurup kendi login komutuyla giriş yapın.`);
    const launch = resolveLaunch(cfg, bin);
    const { env } = buildChildEnv(cfg, process.env, { target, jobId: 'model-discovery', tmpDir: cwd, cliBin: bin });
    if (target === 'claude') env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    const args = target === 'codex'
      ? ['--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps', '-c', 'mcp_servers={}',
         ...codexBaseUrlArgs(cfg), 'app-server']
      : ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--no-session-persistence',
         '--strict-mcp-config', '--mcp-config={"mcpServers":{}}', '--disable-slash-commands', '--tools=',
         '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true })];
    this.child = spawn(launch.cmd, [...launch.pre, ...args], { env, cwd, stdio: 'pipe', windowsHide: true });
    this.ended = new Promise((resolve) => this.child.once('close', resolve));
    this.timer = setTimeout(() => this.fail(new Error('CLI model keşfi 20 saniyede tamamlanmadı. CLI girişini ve bağlantısını kontrol edin.')), 20_000);
    this.child.once('error', () => this.fail(new Error('CLI model keşif süreci başlatılamadı.')));
    this.child.once('exit', () => { this.exited = true; });
    this.child.once('close', () => { this.exited = true; this.fail(new Error('CLI model kontrol protokolü kapandı; CLI sürümünü ve girişini kontrol edin.')); });
    this.child.stdin.on('error', () => this.fail(new Error('CLI kontrol kanalı yazılamadı.')));
    this.child.stderr.on('data', (data: Buffer) => this.bound(data.length));
    this.child.stdout.on('data', (data: Buffer) => this.bound(data.length));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (this.closed) return;
      let message: Record<string, unknown>;
      let response: Record<string, unknown>;
      try {
        message = record(JSON.parse(line) as unknown);
        response = message.type === 'control_response' ? record(message.response) : message;
      } catch { this.fail(new Error('CLI kontrol protokolü geçersiz JSON döndürdü.')); return; }
      const id = response?.request_id ?? response?.id;
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      if (response.error || response.subtype === 'error') pending.reject(new Error('CLI model keşfini reddetti; CLI girişini/sağlayıcı ayarlarını kontrol edin.'));
      else pending.resolve(message.type === 'control_response' ? response.response : response.result);
    });
  }
  private bound(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > 4 * 1024 * 1024) this.fail(new Error('CLI keşif yanıtı boyut sınırını aştı.'));
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.close();
  }
  send(message: unknown): void { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method: string, params: unknown, claude = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CLI kontrol oturumu kapalı.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(claude ? { type: 'control_request', request_id: id, request: params } : { jsonrpc: '2.0', id, method, params });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.child.stdin.end();
    if (!this.exited && this.child.pid) signalAll([this.child.pid], 'SIGTERM');
    const timer = setTimeout(() => { if (!this.exited && this.child.pid) signalAll([this.child.pid], 'SIGKILL'); }, 1500);
    timer.unref();
  }
  async dispose(): Promise<void> {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.ended, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI model keşif süreci kapatılamadı.')), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

function metadataStamp(file: string): string {
  try { const s = fs.statSync(file); return `${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
  catch { return file + ':missing'; }
}
const cache = new Map<string, { at: number; value: ModelCatalogue }>();
const inflight = new Map<string, Promise<ModelCatalogue>>();
export async function listModels(cfg: Config, target: Target, refresh = false): Promise<ModelCatalogue> {
  const bin = cfg.bins[target];
  const metadata = target === 'codex'
    ? ['config.toml', 'auth.json'].map((f) => metadataStamp(path.join(cfg.codexHome, f)))
    : ['settings.json', '.credentials.json'].map((f) => metadataStamp(path.join(cfg.claudeConfigDir, f))).concat(metadataStamp(path.join(cfg.userHome, '.claude.json')));
  const provider = Object.entries(process.env).filter(([key]) => /^(?:ANTHROPIC|CLAUDE|OPENAI|CODEX|AWS|GOOGLE|GCLOUD|AZURE)_/.test(key));
  const key = createHash('sha256').update(JSON.stringify([target, bin && binFingerprint(bin), cfg.codexHome, cfg.claudeConfigDir, metadata, provider])).digest('hex');
  const saved = cache.get(key);
  if (!refresh && saved && Date.now() - saved.at < 60_000) return saved.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = discoverModels(cfg, target).then((value) => {
    if (cache.size > 32) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

async function discoverModels(cfg: Config, target: Target): Promise<ModelCatalogue> {
  const scratch = layout(cfg).scratch;
  ensureDir0700(scratch);
  const session = new ControlSession(cfg, target, scratch);
  const models: ModelInfo[] = [];
  try {
    if (target === 'codex') {
      await session.request('initialize', { clientInfo: { name: 'clivoxa', version: VERSION }, capabilities: { explicitGatewayOauth: true } });
      session.send({ jsonrpc: '2.0', method: 'initialized' });
      const gateway = record(await session.request('account/gatewayOAuth/read', {}));
      if (gateway?.required) throw new Error('Codex sağlayıcısı giriş istiyor. Codex CLI ile giriş yapın.');
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 32; page++) {
        const result = record(await session.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(result?.data)) throw new Error('Codex model/list yanıtı desteklenmiyor.');
        for (const raw of result.data as unknown[]) {
          const item = record(raw);
          if (typeof item.model !== 'string' || !selectionValue(item.model)) throw new Error('Codex geçersiz model kimliği döndürdü.');
          const efforts = Array.isArray(item.supportedReasoningEfforts) ? stringValues((item.supportedReasoningEfforts as unknown[]).map((entry) => record(entry).reasoningEffort)) : null;
          models.push({ id: item.model, displayName: String(item.displayName ?? item.model), efforts,
            ...(typeof item.defaultReasoningEffort === 'string' ? { defaultEffort: item.defaultReasoningEffort } : {}), isDefault: item.isDefault === true });
        }
        if (!result.nextCursor) break;
        if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor) || page === 31) throw new Error('Codex model sayfalaması sınırı aştı veya döngü oluşturdu.');
        cursor = result.nextCursor;
        seen.add(cursor!);
      }
    } else {
      const result = record(await session.request('initialize', { subtype: 'initialize' }, true));
      if (!Array.isArray(result?.models)) throw new Error('Claude CLI initialize model kataloğu desteklenmiyor.');
      for (const raw of result.models as unknown[]) {
        const item = record(raw);
        if (typeof item.value !== 'string' || !selectionValue(item.value)) throw new Error('Claude geçersiz model kimliği döndürdü.');
        models.push({ id: item.value, displayName: String(item.displayName ?? item.value), ...(typeof item.resolvedModel === 'string' ? { resolvedModel: item.resolvedModel } : {}),
          efforts: stringValues(item.supportedEffortLevels),
          isDefault: item.value === 'default' });
      }
    }
    return { target, source: target === 'codex' ? 'codex/app-server/model/list' : 'claude/control/initialize', observedAt: new Date().toISOString(), sourceFreshness: 'unknown', accessVerified: false, models };
  } finally { await session.dispose(); }
}
