import type { Target } from './ids.js';

/** Why a job ended in error (stored in result.json and used to choose the user-facing message). */
export type ErrorKind =
  | 'cancelled' | 'timeout' | 'self_check' | 'empty_answer' | 'interrupted' | 'max_turns' | 'too_big' | 'limit'
  | 'resume_not_found' | 'session_busy' | 'effort_rejected' | 'auth' | 'model' | 'managed_mcp' | 'network'
  | 'sandbox_unavailable' | 'cli_error' | 'spawn_failed' | 'mcp_isolation_failed' | 'codex_profile_unverified' | 'codex_write_unverified'
  | 'orphaned' | 'runner_start_failed' | 'internal' | 'bin_missing' | 'cli_too_old' | 'workdir_scan_incomplete';

export type JobStatus = 'running' | 'done' | 'error';
export type Web = 'off' | 'search' | 'live';

/** What a Codex review job reviews: uncommitted changes, the diff against a base branch, or one commit. */
export interface ReviewTarget {
  scope: 'uncommitted' | 'base' | 'commit';
  ref: string | null;
}

export interface JobRequest {
  schema: 1;
  job_id: string;
  target: Target;
  created_at: string;
  created_at_ms: number;
  nonce: string;
  access: 'read' | 'write';
  workdir: string | null;
  cwd: string;
  git_top: string | null;
  git_dirs: string[];
  shell: boolean;
  web: Web;
  network: boolean;
  git_write: boolean;
  /** Codex only: run Codex's own reviewer (`codex exec review`) instead of a plain turn. Absent in older requests. */
  review?: ReviewTarget | null;
  effort: string;
  model: string;
  label: string | null;
  session_id_requested: string | null;
  /** Claude: session id to create for a new conversation. */
  new_session_id: string | null;
  prompt_chars: number;
  context_chars: number;
  prompt_preview: string;
  caller: { client?: string; client_version?: string; thread_id?: string; session_id?: string };
  host: string;
  warnings: string[];
}

export interface AttemptRecord {
  n: number;
  effort: string;
  mode: 'new' | 'resume';
  stdin: string;
  started_at: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  session_id?: string | null;
  outcome?: string;
  error_kind?: ErrorKind;
  error_detail?: string;
}

export interface ChangesSummary {
  git: boolean;
  files: { path: string; status: string }[];
  more: number;
  touched_untracked_or_ignored: string[];
  preexisting_dirty: string[];
  head_before: string | null;
  head_after: string | null;
  new_commits: string[];
  executable_surfaces: string[];
  from_events: string[];
  note?: string;
}

export interface ProtectedItem {
  path: string;
  action: 'reverted' | 'removed' | 'restored' | 'unrestorable' | 'quarantined' | 'placeholder_removed' | 'reported';
  saved_as?: string;
}

export interface ProtectedSummary {
  items: ProtectedItem[];
  policy: 'revert' | 'report';
  scan_complete: boolean;
}

export interface Meta {
  schema: 1;
  job_id: string;
  target: Target;
  status: 'starting' | 'running' | 'done' | 'error';
  phase: 'starting' | 'preparing' | 'running' | 'retrying' | 'cancelling' | 'finishing' | 'finished';
  created_at: string;
  started_at?: string;
  finished_at?: string;
  session_id?: string | null;
  resumed?: boolean;
  effort_used?: string;
  resolved_model?: string;
  /** The reasoning effort the CLI ran with, when known (requested, retried, or its configured default). */
  effective_effort?: string;
  sandbox?: string;
  notes: string[];
  warnings: string[];
  attempts: AttemptRecord[];
  child?: { pid: number; marker: string; argv_redacted: string[] };
  progress?: { at: string; summary: string; events: number };
  usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; total_cost_usd?: number };
  permission_denials?: string[];
  changes?: ChangesSummary;
  protected?: ProtectedSummary;
  redactions?: Record<string, number>;
  versions: { server: string; cli?: string };
}

export interface JobResult {
  status: 'done' | 'error';
  error_kind?: ErrorKind;
  error_message?: string;
  error_detail?: string;
  by: 'runner' | 'reaper' | 'cancel';
  finished_at: string;
  child_code: number | null;
  has_answer: boolean;
  partial_answer: boolean;
  reaped_in_error?: boolean;
}

export interface JobView {
  job_id: string;
  target: Target;
  status: JobStatus;
  phase?: string;
  job_dir: string;
  elapsed_s: number;
  request: JobRequest;
  meta: Meta | null;
  result: JobResult | null;
  answer: string | null;
  partial_answer: string | null;
  last_activity: string | null;
  warnings: string[];
}
