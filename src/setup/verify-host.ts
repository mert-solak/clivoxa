import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from '../config/config.js';
import { askToolName } from '../domain/ids.js';
import { cmpVersion, MIN_CLAUDE, MIN_CODEX } from '../providers/capabilities.js';
import { resolveLaunch } from '../providers/child-env.js';
import { LOOP_GUARD_ENV } from '../security/guards.js';
import { systemEnvironment } from '../system/platform/index.js';
import type { HostLaunch, SetupHost } from './host-config.js';

/** Deliberately approximate a GUI launch, without importing terminal-only credentials. */
export function verificationEnvironment(launch: HostLaunch, home: string, source: NodeJS.ProcessEnv, profile = home): Record<string, string> {
  // A Windows GUI launch keeps the user profile even when HOME differs; the CLIs read their files from it.
  const env: Record<string, string> = { ...systemEnvironment(source), HOME: home, USERPROFILE: profile, PATH: '', ...launch.env };
  // A setup invoked inside a consulted agent must not escape the loop/sandbox guards.
  for (const key of LOOP_GUARD_ENV) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}

/** The counterpart CLI's `--version` number, or null when it cannot be run or read. */
export function cliVersion(cfg: Config, target: 'codex' | 'claude', env: NodeJS.ProcessEnv): string | null {
  const bin = cfg.bins[target];
  if (!bin) return null;
  const launch = resolveLaunch(cfg, bin);
  const r = spawnSync(launch.cmd, [...launch.pre, '--version'], { env, cwd: cfg.userHome, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024 });
  if (r.error || r.status !== 0) return null;
  return /\b\d{1,4}\.\d{1,4}\.\d{1,4}\b/.exec(r.stdout)?.[0] ?? null;
}

/**
 * The minimum supported version when `version` is below it, else null. The runner refuses such a CLI
 * (cli_too_old), so registering it would only produce failing jobs. An unreadable version is not judged here.
 */
export function unsupportedFloor(target: 'codex' | 'claude', version: string | null): string | null {
  const floor = target === 'codex' ? MIN_CODEX : MIN_CLAUDE;
  return version && cmpVersion(version, floor) < 0 ? floor : null;
}

/** The counterpart CLI found for a host; whether it is signed in is reported by the first job that needs it. */
export interface ProviderStatus {
  version: string | null;
}

export interface Verification {
  tools: number;
  catalogue: 'available' | 'unavailable';
  modelCount: number | null;
}

/** Exercise the exact saved command/argv/env; this is not evidence of a GUI connection. */
export async function verifyHost(host: SetupHost, launch: HostLaunch, home: string, source: NodeJS.ProcessEnv, options: { catalogue?: boolean; profile?: string } = {}): Promise<Verification> {
  const client = new Client({ name: 'clivoxa-setup', version: '1' });
  const transport = new StdioClientTransport({
    command: launch.command, args: launch.args, env: verificationEnvironment(launch, home, source, options.profile),
    cwd: home, stderr: 'pipe', maxBufferSize: 4 * 1024 * 1024,
  });
  // Never echo server output, which could carry provider details. Keep only the server's own,
  // already-masked refusal reason, so a guard refusal is not reported as an unexplained failure.
  let refusal: string | null = null;
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    tail = (tail + String(chunk)).slice(-8192);
    refusal = /araç sunulmuyor: ([^\r\n]{1,300})/.exec(tail)?.[1] ?? refusal;
  });
  try {
    await client.connect(transport, { timeout: 35_000 });
    const names = (await client.listTools({}, { timeout: 35_000 })).tools.map(tool => tool.name).sort();
    const expected = [askToolName(host.role), 'cancel_job', 'get_job', 'list_jobs', 'list_models'].sort();
    if (client.getServerVersion()?.name !== 'clivoxa' || JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error('Unexpected MCP tools');
    }
    let modelCount: number | null = null;
    if (options.catalogue !== false) try {
      const response = await client.callTool({ name: 'list_models', arguments: { refresh: true } }, undefined, { timeout: 30_000 });
      if (!response.isError && Array.isArray(response.content)) {
        const body = response.content.find(item => item.type === 'text');
        const catalogue = body && typeof body.text === 'string' ? JSON.parse(body.text) as { target?: string; models?: unknown[] } : null;
        if (catalogue?.target === host.role && Array.isArray(catalogue.models) && catalogue.models.length > 0) modelCount = catalogue.models.length;
      }
    } catch { /* Registration is useful even when login or network metadata is temporarily unavailable. */ }
    return { tools: names.length, catalogue: modelCount === null ? 'unavailable' : 'available', modelCount };
  } catch (error) {
    const cause = refusal ? `sunucu araç sunmayı reddetti: ${refusal}`
      : /timed out|timeout/i.test(String((error as Error | undefined)?.message)) ? 'zaman aşımı' : null;
    throw new Error(`${host.label}: Clivoxa test sırasında başlatılamadı${cause ? ` (${cause})` : ''}; hiçbir kayıt değiştirilmedi. Ayrıntı için "npx -y github:mert-solak/clivoxa doctor" çalıştırın.`);
  } finally {
    await client.close();
    await transport.close();
  }
}
