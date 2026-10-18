import path from 'node:path';
import type { SetupHost } from './host-config.js';

export interface OwnedHost { host: SetupHost; fingerprint: string }

export interface Installation {
  schema: 1; version: string; runtime: string; hosts: OwnedHost[];
}

export function readInstallation(text: string | null): Installation | null {
  if (text === null) return null;
  try {
    const result = JSON.parse(text) as Installation;
    if (result.schema !== 1 || typeof result.version !== 'string' || !path.isAbsolute(result.runtime) || !Array.isArray(result.hosts)) throw new Error();
    for (const item of result.hosts) {
      if (!item.host || !['claude-code', 'claude-desktop', 'codex'].includes(item.host.id) ||
          !path.isAbsolute(item.host.file) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw new Error();
    }
    return result;
  } catch { throw new Error('Clivoxa kurulum manifesti geçersiz; mevcut dosya değiştirilmedi.'); }
}
