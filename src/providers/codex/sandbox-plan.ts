import type { Config } from '../../config/config.js';
import type { JobRequest } from '../../domain/job.js';
import { profileName, profileToml, type CodexSandbox, type ProfileOpts } from './argv.js';
import type { SandboxRecord } from '../capabilities.js';
import { msg } from '../../shared/messages.js';

export interface CodexSandboxDecision {
  sandbox: CodexSandbox;
  label: string;
  warnings: string[];
}

/** Why a request gets no sandbox: its read profile, or the write profile it needs, is unverified. */
export interface CodexSandboxRefusal {
  kind: 'codex_profile_unverified' | 'codex_write_unverified';
  error: string;
}

/** Decide the Codex sandbox for a request, or why it is not allowed (Turkish message). */
export function decideCodexSandbox(
  cfg: Config,
  req: Pick<JobRequest, 'access' | 'workdir' | 'git_write' | 'network' | 'review'>,
  rec: SandboxRecord | null,
  git?: ProfileOpts['git'],
): CodexSandboxDecision | CodexSandboxRefusal {
  const warnings: string[] = [];
  if (req.access === 'read') {
    const opts: ProfileOpts = { kind: 'ro', gitWrite: false, network: false, allowSlashTmp: cfg.allowSlashTmp };
    if (!req.workdir) {
      // No shell anyway; the verified profile's read-deny list still adds defence in depth (e.g. apply_patch probes).
      if (cfg.codexSandbox !== 'legacy' && rec?.profiles_verified.ro) {
        const name = profileName(opts);
        return { sandbox: { kind: 'profiles', name, toml: profileToml(cfg, opts) }, label: `profiles(${name}, kabuksuz)`, warnings };
      }
      return { sandbox: { kind: 'legacy' }, label: 'read-only (kabuksuz)', warnings };
    }
    // Codex's reviewer is another code path: it gets file access only once the same probes passed through it.
    if (req.review && !(cfg.codexSandbox !== 'legacy' && rec?.profiles_verified.ro && rec.profiles_verified.review)) {
      return { kind: 'codex_profile_unverified', error: msg('codex_profile_unverified', { detail: 'clivoxa_ro (inceleme): inceleme modu için otomatik sandbox kontrolünün inceleme üzerinden de geçmesi gerekir' }) };
    }
    if (cfg.codexSandbox !== 'legacy' && rec?.profiles_verified.ro) {
      const name = profileName(opts);
      return { sandbox: { kind: 'profiles', name, toml: profileToml(cfg, opts) }, label: `profiles(${name})`, warnings };
    }
    return { kind: 'codex_profile_unverified', error: msg('codex_profile_unverified', { detail: 'clivoxa_ro: dosya erişimi için otomatik sandbox kontrolünün geçmesi gerekir' }) };
  }
  const net = req.network && cfg.codexNetwork === 'open';
  const opts: ProfileOpts = { kind: 'rw', gitWrite: req.git_write, network: net, allowSlashTmp: cfg.allowSlashTmp, ...(git ? { git } : {}) };
  const need: string[] = [];
  if (!rec?.profiles_verified.rw) need.push('clivoxa_rw');
  if (req.git_write && !rec?.profiles_verified.rw_git) need.push('git yazma');
  if (net && !rec?.profiles_verified.rw_net) need.push('ağ');
  if (cfg.codexSandbox === 'legacy') need.push('CLIVOXA_CODEX_SANDBOX=legacy');
  if (need.length) return { kind: 'codex_write_unverified', error: msg('codex_write_unverified', { detail: need.join(', ') }) };
  if (net) warnings.push(msg('network_open_warning'));
  const name = profileName(opts);
  return { sandbox: { kind: 'profiles', name, toml: profileToml(cfg, opts) }, label: `profiles(${name})`, warnings };
}
