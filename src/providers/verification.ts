import { type Config, layout } from '../config/config.js';
import { readSandboxRecord, binFingerprint, sandboxContext } from './capabilities.js';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDir0700, readJsonSafe, sleep, writeJsonAtomic } from '../system/fs.js';
import { isGone } from '../system/platform/index.js';
import { packageScriptUrl } from '../system/entrypoints.js';

/** A live verifier refreshes its lease; one left unrefreshed this long is stale even when its pid was reused. */
const LEASE_REFRESH_MS = 5_000;
const LEASE_STALE_MS = 120_000;

/** A filesystem lease serializes verification across detached runners and MCP hosts. */
async function withVerificationLease(cfg: Config, target: string, cached: () => boolean, verify: () => Promise<void>): Promise<void> {
  const caps = layout(cfg).caps;
  ensureDir0700(caps);
  const lock = path.join(caps, `.verify-${target}-${sandboxContext(cfg)}.lock`);
  const ownerFile = path.join(lock, 'owner.json');
  const token = randomUUID();
  const owned = () => readJsonSafe<{token?:string}>(ownerFile)?.token === token;
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (cached()) return;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        writeJsonAtomic(ownerFile, { pid: process.pid, token });
      } catch (error) {
        // An ownerless lease would make every other verifier wait for the stale rule.
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readJsonSafe<{pid:number}>(ownerFile);
      let age = 0;
      try { age = Date.now() - fs.lstatSync(lock).mtimeMs; } catch { continue; }
      // A dead owner stops refreshing its lease, also when its pid now names another or an inaccessible process.
      if ((owner && isGone(owner.pid)) || (!owner && age > 10_000) || age > LEASE_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Sandbox doğrulaması başka bir süreçte tamamlanmadı.');
      await sleep(250);
    }
  }
  const refresh = setInterval(() => {
    try { if (owned()) { const now = new Date(); fs.utimesSync(lock, now, now); } } catch { /* released or taken over */ }
  }, LEASE_REFRESH_MS);
  refresh.unref();
  try { if (!cached()) await verify(); }
  finally {
    clearInterval(refresh);
    // A lease taken over while this verifier stalled belongs to its new owner.
    if (owned()) fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** `settings: 'file'`: verified with settings passed as a file, as jobs pass them; older records are re-verified. */
interface ClaudeRecord { fp: string; context: string; at: number; read: boolean; write: boolean; details: Record<string,string>; settings?: 'file' }
/** Where the Claude sandbox verification for the binary with fingerprint `fp` is recorded. */
export function claudeRecordPath(cfg: Config, fp: string): string {
  return path.join(layout(cfg).caps, `claude-sandbox-${fp}.json`);
}
export function readClaudeRecord(cfg: Config): ClaudeRecord | null {
  if (!cfg.bins.claude) return null;
  const fp = binFingerprint(cfg.bins.claude);
  if (!fp) return null;
  const record = readJsonSafe<ClaudeRecord>(claudeRecordPath(cfg, fp));
  return record && record.fp === fp && record.context === sandboxContext(cfg) && record.settings === 'file' && Date.now() - record.at < 86400_000 ? record : null;
}
export async function ensureClaudeVerified(cfg: Config): Promise<ClaudeRecord | null> {
  const cached = readClaudeRecord(cfg);
  if (cached) return cached;
  const key = `claude:${cfg.bins.claude}:${cfg.home}`;
  const existing = pending.get(key);
  if (existing) { await existing; return readClaudeRecord(cfg); }
  const work = withVerificationLease(cfg, 'claude', () => !!readClaudeRecord(cfg), async () => {
    const verifier = await import(packageScriptUrl('verify-claude.mjs'));
    await verifier.verifyClaudeSandbox({ cfg });
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  await work;
  return readClaudeRecord(cfg);
}

const pending = new Map<string, Promise<void>>();
/** Verification uses a loopback mock model, never the user's provider or paid inference. */
export async function ensureCodexVerified(cfg: Config): Promise<void> {
  const lay = layout(cfg);
  if (readSandboxRecord(cfg, lay.caps)) return;
  const key = `${cfg.bins.codex}:${cfg.home}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = withVerificationLease(cfg, 'codex', () => !!readSandboxRecord(cfg, lay.caps), async () => {
    const verifier = await import(packageScriptUrl('verify-sandbox.mjs'));
    await verifier.verifyCodexProfiles({ cfg });
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
