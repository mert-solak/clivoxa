export interface SetupOptions {
  selected: 'both' | 'claude' | 'claude-code' | 'claude-desktop' | 'codex';
  /** Replace the recorded read/write ceiling; without it an existing ceiling is kept. */
  maxAccess?: 'read' | 'write';
  local: boolean;
  json: boolean;
  verbose: boolean;
}

export function parseSetupOptions(args: string[]): SetupOptions {
  const result: SetupOptions = { selected: 'both', local: false, json: false, verbose: false };
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--local') result.local = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--verbose') result.verbose = true;
    else if (arg === '--max-access') {
      const value = args[++i];
      if (value !== 'read' && value !== 'write') throw new Error('--max-access must be read or write.');
      result.maxAccess = value;
    }
    else if (!positional && ['both', 'claude', 'claude-code', 'claude-desktop', 'codex'].includes(arg)) {
      result.selected = arg as SetupOptions['selected']; positional = true;
    } else throw new Error('Usage: clivoxa setup [both|claude|claude-code|claude-desktop|codex] [--max-access read|write] [--verbose] [--json] [--local]');
  }
  return result;
}
