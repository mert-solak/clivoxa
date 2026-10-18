import { execFile } from 'node:child_process';
import { powershellLanguageMode, windowsPowerShell } from '../system/platform/index.js';
import { msg } from '../shared/messages.js';

export class WindowsAclError extends Error {
  readonly code = 'CONFIG_ACL_UNAVAILABLE';
  constructor(stage = 'unavailable', explanation?: string) {
    super(explanation ?? `Windows configuration permissions could not be applied and verified (${stage}). Setup cannot safely continue.`);
    this.name = 'WindowsAclError';
  }
}

/** The error for a failed helper run: a constrained PowerShell (WDAC/AppLocker) is named, since retrying cannot help. */
export function aclFailure(stage: string, languageMode: () => string | null = powershellLanguageMode): WindowsAclError {
  const mode = languageMode();
  return mode && mode !== 'FullLanguage' ? new WindowsAclError('constrained-language', msg('powershell_language_mode', { mode })) : new WindowsAclError(stage);
}

// Fixed code only. Paths and security descriptors arrive as base64-encoded
// environment data; neither config contents nor user input becomes PowerShell.
// .NET Framework's FileStream security overload applies the DACL at CreateNew,
// avoiding an inherited-ACL window before the file contains credentials.
const script = `
$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
$phase = 'DESCRIPTOR';
try {
  $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CLIVOXA_ACL_PATH));
  $section = [Security.AccessControl.AccessControlSections]::Access;
  function AccessDescriptor($security) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorSddlForm($section));
    # AUTO_INHERITED records how Windows built this descriptor; CreateNew may
    # omit it for protected OR unprotected descriptors. Keep every ACE (including
    # inherited flags), DACL protection and AUTO_INHERIT_REQUIRED unchanged.
    $flags = $raw.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited);
    $raw.SetFlags([Security.AccessControl.ControlFlags]$flags);
    return $raw.GetSddlForm($section);
  }
  if ($env:CLIVOXA_ACL_OPERATION -eq 'create') {
    $security = [Security.AccessControl.FileSecurity]::new();
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User;
    $security.SetAccessRuleProtection($true, $false);
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow);
    $security.AddAccessRule($rule);
    $desired=$null;
    if ($env:CLIVOXA_ACL_DACL) {
      $sddl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CLIVOXA_ACL_DACL));
      $desired=[Security.AccessControl.FileSecurity]::new();
      $desired.SetSecurityDescriptorSddlForm($sddl,$section);
    }
    $expected = AccessDescriptor $security;
    $phase = 'CREATE';
    $stream = [IO.FileStream]::new($file, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security);
    $stream.Dispose();
    if ($desired) {
      # Restore inheritance on an existing empty file, not through CreateNew.
      # Verify the result before Node opens it to write any configuration data.
      $phase='APPLY';
      [IO.File]::SetAccessControl($file,$desired);
      $expected=AccessDescriptor $desired;
    }
  } elseif ($env:CLIVOXA_ACL_OPERATION -ne 'read') {
    throw 'Unsupported ACL operation';
  }
  $phase = 'INSPECT';
  $attributes = [IO.File]::GetAttributes($file);
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Not a regular file'; }
  $observedSecurity=[IO.File]::GetAccessControl($file,$section);
  $actual = AccessDescriptor $observedSecurity;
  $phase = 'VERIFY';
  if ($env:CLIVOXA_ACL_OPERATION -eq 'create' -and $actual -cne $expected) {
    $wanted=[Security.AccessControl.RawSecurityDescriptor]::new($expected);
    $observed=[Security.AccessControl.RawSecurityDescriptor]::new($actual);
    $phase='VERIFY_RULES';
    if ($wanted.ControlFlags -ne $observed.ControlFlags) {$phase='VERIFY_INHERITANCE';}
    elseif ($wanted.DiscretionaryAcl.Count -ne $observed.DiscretionaryAcl.Count) {$phase='VERIFY_RULE_COUNT';}
    throw 'DACL verification failed';
  }
  # Keep the native descriptor for later application. Normalization is for
  # comparison only; stripping flags before reapplying can alter inheritance.
  $native=$observedSecurity.GetSecurityDescriptorSddlForm($section);
  [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($native)));
} catch {
  [Console]::Error.WriteLine('CLIVOXA_ACL_' + $phase);
  exit 1;
}
`;

async function run(operation: 'read' | 'create', file: string, dacl?: string | null): Promise<string> {
  const powershell = process.platform === 'win32' ? windowsPowerShell() : null;
  if (!powershell) throw new WindowsAclError();
  const env = {
    ...process.env,
    CLIVOXA_ACL_OPERATION: operation,
    CLIVOXA_ACL_PATH: Buffer.from(file, 'utf8').toString('base64'),
    CLIVOXA_ACL_DACL: dacl ? Buffer.from(dacl, 'utf8').toString('base64') : '',
  };
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
    }, (error, stdout, stderr) => {
      // Never expose PowerShell diagnostics, paths or environment values.
      if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout)) {
        // PowerShell may wrap error records in CLIXML. Extract only our fixed
        // stage tag, never forward diagnostic text containing paths or secrets.
        const stage = /CLIVOXA_ACL_(DESCRIPTOR|CREATE|APPLY|INSPECT|VERIFY(?:_RULES|_INHERITANCE|_RULE_COUNT)?)(?=_x000D_|_x000A_|\s|<|$)/.exec(stderr)?.[1]?.toLowerCase();
        reject(aclFailure(stage ?? (error?.killed ? 'timeout' : error ? 'process' : 'response'))); return;
      }
      const decoded = Buffer.from(stdout, 'base64').toString('utf8');
      if (!decoded.startsWith('D:') || Buffer.from(decoded, 'utf8').toString('base64') !== stdout) {reject(new WindowsAclError()); return;}
      resolve(decoded);
    });
  });
}

export function canonicalWindowsDacl(native: string): string {
  if (!native.startsWith('D:')) throw new WindowsAclError('descriptor');
  const firstAce=native.indexOf('(');
  const end=firstAce<0?native.length:firstAce;
  return native.slice(0,end).replaceAll('AI','')+native.slice(end);
}
export function readWindowsDaclRaw(file: string): Promise<string> {return run('read', file);}
export async function readWindowsDacl(file: string): Promise<string> {return canonicalWindowsDacl(await readWindowsDaclRaw(file));}
/** Creates an empty file atomically with the requested DACL; null means user-only. */
export async function createWindowsPrivateFile(file: string, dacl: string | null = null): Promise<string> {
  return canonicalWindowsDacl(await run('create', file, dacl));
}
