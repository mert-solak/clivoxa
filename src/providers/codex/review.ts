import type { ReviewTarget } from '../../domain/job.js';

/**
 * The review request handed to `codex exec review -`. Codex's presets (`--uncommitted`, `--base`,
 * `--commit`) refuse custom instructions, so the target is stated in the same words and the caller's
 * focus follows; Codex's own review guidelines apply either way.
 */
export function reviewInstruction(t: ReviewTarget, focus: string): string {
  const what =
    t.scope === 'uncommitted' ? 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.'
    : t.scope === 'base' ? `Review the code changes against the base branch '${t.ref}': find the merge base with \`git merge-base HEAD ${t.ref}\`, review the diff from it, and provide prioritized findings.`
    : `Review the code changes introduced by commit ${t.ref} and provide prioritized findings.`;
  return `${what}\n\nFocus requested by the caller:\n${focus}`;
}
