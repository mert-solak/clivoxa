import { HOST_NAMES, type SetupHost } from './host-config.js';
import type { Verification, ProviderStatus } from './verify-host.js';
import { terminalStyle } from './terminal-style.js';

export interface HostResult extends Verification {
  id: SetupHost['id']; label: string; file: string; changed: boolean; enabled: boolean;
  provider: ProviderStatus;
  hostConnection: 'restart-required' | 'disabled';
}

/** An application setup left alone: why, and what the user has to do before running setup again. */
export interface SkippedHost { host: string; reason: string; fix: string[] }

export interface SetupReport { version: string; runtime: string; hosts: HostResult[]; skipped: SkippedHost[]; ready: boolean }

const HOST_ORDER: readonly SetupHost['id'][] = ['claude-code', 'claude-desktop', 'codex'];

/** One name per application: several Desktop profiles are one app to the user. */
export function hostNames(hosts: readonly { id: SetupHost['id'] }[]): string[] {
  return HOST_ORDER.filter(id => hosts.some(host => host.id === id)).map(id => HOST_NAMES[id]);
}

/** Record a skipped application once, however many of its profiles were skipped. */
export function addSkip(skipped: SkippedHost[], entry: SkippedHost): void {
  if (!skipped.some(item => item.host === entry.host && item.reason === entry.reason)) skipped.push(entry);
}

/** Plain-text form for an error that ends setup before anything was installed. */
export function skipSummary(skipped: readonly SkippedHost[]): string {
  return skipped.map(item => `${item.host}: ${item.reason}. ${item.fix.join(' ')}`.trim()).join('\n');
}

export function printSetupReport(report: SetupReport, options: { json: boolean; verbose?: boolean }): void {
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  const style = terminalStyle(process.stdout);
  const names = [...hostNames(report.hosts), ...report.skipped.map(item => item.host)];
  const width = Math.max(...names.map(name => name.length));
  const row = (name: string, detail: string): void => console.log(`  ${name.padEnd(width)}   ${detail}`);
  const todo = new Set<string>();
  let warnings = report.skipped.length;
  console.log('');
  for (const id of HOST_ORDER) {
    const group = report.hosts.filter(host => host.id === id);
    const first = group[0];
    if (!first) continue;
    // The counterpart CLI this host consults: Claude hosts use Codex and vice versa.
    const [cli, login] = id === 'codex' ? ['Claude Code', 'claude auth login'] : ['Codex', 'codex login'];
    let detail = 'bağlandı';
    if (group.some(host => !host.enabled)) {
      detail = 'eklendi, kullanıcı ayarıyla devre dışı';
    } else if (first.catalogue !== 'available') {
      detail = 'eklendi, model listesi alınamadı';
      todo.add(`${cli} girişi (${login}) ve internet bağlantısı kontrol edilmeli.`);
    }
    if (detail !== 'bağlandı') warnings++;
    if (options.verbose && first.catalogue === 'available') detail += ` (${first.modelCount} model)`;
    row(HOST_NAMES[id], detail);
    if (options.verbose) for (const host of group) console.log(style.dim(`  ${''.padEnd(width)}   ${host.file}`));
  }
  for (const item of report.skipped) {
    row(item.host, `atlandı: ${item.reason}`);
    for (const fix of item.fix) todo.add(fix);
  }
  if (options.verbose) console.log(style.dim(`\n  Runtime: ${report.runtime}`));
  if (report.skipped.length) todo.add('Kurulum yeniden çalıştırılmalı.');
  console.log(`\n${style.bold(warnings ? `Kurulum ${warnings} uyarıyla tamamlandı.` : 'Kurulum tamamlandı.')}`);
  if (todo.size) {
    console.log('\nSonraki adımlar:');
    [...todo].forEach((item, i) => console.log(`  ${i + 1}. ${item}`));
  }
}
