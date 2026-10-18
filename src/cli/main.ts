#!/usr/bin/env node
import { loadConfig } from '../config/config.js';
import { VERSION } from '../shared/version.js';
import { setup } from '../setup/setup.js';
import { printSetupReport } from '../setup/report.js';
import { parseSetupOptions } from '../setup/options.js';
import { uninstall } from '../setup/uninstall.js';
import { doctorReport } from './doctor.js';

/** Normal MCP operation is the default; this CLI never prints on the MCP stdout channel. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--clivoxa-runner')) { await import('../runner/main.js'); return; }
  const command = args[0];
  if (!command) { await import('../mcp/server.js'); return; }
  if (command === '--version' || command === '-v') { console.log(VERSION); return; }
  if (command === '--help' || command === '-h') {
    console.log([
      'Clivoxa — Claude/Codex CLI MCP bridge',
      '',
      'clivoxa                     Start the MCP server over stdio (CLIVOXA_EXPOSE=codex|claude)',
      'clivoxa setup [--verbose]   Register Clivoxa in detected Claude Code, Claude Desktop and Codex',
      'clivoxa uninstall           Remove unchanged registrations owned by setup',
      'clivoxa doctor [--verify]   Report local capabilities as JSON (--verify re-runs sandbox checks)',
      '',
      'Node.js >=22; installed and signed-in Codex / Claude Code CLIs required.',
    ].join('\n'));
    return;
  }
  const cfg = loadConfig();
  if (command === 'doctor') {
    console.log(JSON.stringify(await doctorReport(cfg, { verify: args.includes('--verify') }), null, 2));
    return;
  }
  if (command === 'setup') {
    const options = parseSetupOptions(args.slice(1));
    printSetupReport(await setup(options, cfg), options);
    return;
  }
  if (command === 'uninstall') {
    if (args.length !== 1) throw new Error('Usage: clivoxa uninstall');
    await uninstall(cfg);
    return;
  }
  throw new Error(`Unknown command: ${command}. Use clivoxa --help.`);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Startup failed';
  // Installer commands talk to people; the MCP server keeps its log prefix.
  const step = process.argv[2] === 'setup' ? 'Kurulum' : process.argv[2] === 'uninstall' ? 'Kaldırma' : null;
  if (step) console.error(`\n${step} durduruldu: ${message}`);
  else console.error(`[clivoxa] ${message}`);
  process.exitCode = 1;
});
