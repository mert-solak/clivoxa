import * as z from 'zod/v4';
import { JOB_ID_RE, UUID_RE, type Target } from '../domain/ids.js';
import type { Web } from '../domain/job.js';

const waitSchema = z.number().min(0).optional().describe('Wait up to N seconds for the job (default 45; values above 50 are clamped to 50). 0 = return the job_id immediately.');

export function askShape(target: Target) {
  const base = {
    prompt: z.string().min(1).max(200_000).describe("Question or task for the counterpart (Turkish is fine). For a debate: the question + your draft answer + the referee instruction. For a task: goal, scope, acceptance criteria, constraints and the expected report."),
    context: z.string().max(400_000).optional().describe('Supporting material, treated as data. Never include passwords, API keys or account numbers.'),
    effort: z.string().min(1).max(256).optional().describe('Reasoning effort chosen by the caller. Use list_models for this model’s supported values; omitted uses the CLI default. No silent remapping.'),
    model: z.string().min(1).max(256).optional().describe('Model ID or alias chosen by the caller. Discover current options with list_models; omitted uses the CLI default.'),
    session_id: z.string().regex(UUID_RE).optional().describe('Continue an earlier conversation with the same counterpart (session_id from a previous result).'),
    workdir: z.string().min(1).max(4096).optional().describe("Absolute project directory the sub-agent may work in (e.g. the git root). Omit = no files at all (text + web only)."),
    access: z.enum(['read', 'write']).optional().describe("Default 'read'. 'write' ONLY when the user explicitly asked for changes; needs workdir."),
    shell: z.boolean().optional().describe('Read-only shell commands in read mode (default: true with workdir, false without). Write mode always has a shell.'),
    web: z.enum(['off', 'search', 'live']).optional().describe(`Web access for the sub-agent. Default: ${target === 'codex' ? "'search' (cached index)" : "'live' without workdir, 'search' with workdir"}. 'live' opens arbitrary URLs; 'off' for sensitive code.`),
    network: z.boolean().optional().describe('Shell network in write mode (package installs). Default false; may be refused by the install ceiling.'),
    git_write: z.boolean().optional().describe('Write mode only: allow commits/branches in the workdir\'s own repo (no push; hooks, .git/config and nested repos stay read-only). Default false.'),
    label: z.string().max(200).optional().describe("Short archive label, e.g. 'cache tasarımı · tur 2'."),
    wait_seconds: waitSchema,
  };
  if (target !== 'codex') return base;
  return {
    ...base,
    review: z.object({
      scope: z.enum(['uncommitted', 'base', 'commit']).describe("'uncommitted' = staged, unstaged and untracked changes; 'base' = the diff against ref (a branch); 'commit' = the changes of ref (a commit)."),
      ref: z.string().regex(GIT_REF_RE).max(200).optional().describe("Branch for 'base', commit for 'commit'; not used with 'uncommitted'."),
    }).optional().describe("Run Codex's own code reviewer instead of a plain turn: prioritized findings with file:line. Needs workdir (a git repository) and access='read'; prompt = what to focus on. No session_id."),
  };
}

/** A git branch, tag or commit name as the caller may pass it (no spaces, options or revision ranges). */
export const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/@^~-]+$/;

export const listModelsShape = { refresh: z.boolean().optional() };

export const getJobShape = {
  job_id: z.string().regex(JOB_ID_RE).describe('job_id returned by ask_*.'),
  wait_seconds: waitSchema,
  answer_offset: z.number().int().min(0).optional().describe('Character offset to continue reading a long answer.'),
};

export const listJobsShape = { limit: z.number().optional().describe('How many recent jobs (default 20, 1..100).') };

export const cancelJobShape = { job_id: z.string().regex(JOB_ID_RE).describe('job_id to cancel.') };

/** Arguments of ask_codex / ask_claude after schema validation. */
export interface AskArgs {
  prompt: string;
  context?: string;
  effort?: string;
  session_id?: string;
  workdir?: string;
  access?: 'read' | 'write';
  shell?: boolean;
  web?: Web;
  network?: boolean;
  git_write?: boolean;
  label?: string;
  wait_seconds?: number;
  model?: string;
  review?: { scope: 'uncommitted' | 'base' | 'commit'; ref?: string };
}
