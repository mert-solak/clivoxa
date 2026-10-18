import fs from 'node:fs';
import { layout, type Config } from '../config/config.js';
import { binFingerprint, readSandboxRecord, sandboxRecordPath } from '../providers/capabilities.js';
import { claudeRecordPath, ensureClaudeVerified, ensureCodexVerified, readClaudeRecord } from '../providers/verification.js';

/**
 * Local capability report (`clivoxa doctor`). With `verify`, cached sandbox verifications for the
 * counterpart CLIs this installation can run are discarded and verified again first.
 */
export async function doctorReport(cfg: Config, options: { verify: boolean }) {
  const caps = layout(cfg).caps;
  if (options.verify) {
    for (const [target, bin] of [['codex', cfg.bins.codex], ['claude', cfg.bins.claude]] as const) {
      if (!bin || (cfg.expose === 'codex' && target !== 'codex') || (cfg.expose === 'claude' && target !== 'claude')) continue;
      const fp = binFingerprint(bin);
      if (fp) fs.rmSync(target === 'codex' ? sandboxRecordPath(caps, fp) : claudeRecordPath(cfg, fp), { force: true });
      if (target === 'codex') await ensureCodexVerified(cfg); else await ensureClaudeVerified(cfg);
    }
  }
  const codexSandbox = readSandboxRecord(cfg, caps);
  const claudeSandbox = readClaudeRecord(cfg);
  return {
    platform: process.platform, arch: process.arch, node: process.versions.node, role: cfg.expose,
    cli: { codex: !!cfg.bins.codex, claude: !!cfg.bins.claude, git: !!cfg.bins.git },
    maxAccess: cfg.maxAccess, state: cfg.home,
    sandbox: {
      codex: codexSandbox ? { verified: codexSandbox.profiles_verified, details: codexSandbox.details } : 'unverified',
      claude: claudeSandbox ? { read: claudeSandbox.read, write: claudeSandbox.write, details: claudeSandbox.details } : 'unverified',
    },
    notes: ['File access requires a successful local sandbox verification.', 'On Windows a host shutdown may end detached jobs; unfinished jobs are reported as orphaned.'],
  };
}
