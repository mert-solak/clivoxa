import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Liveness } from './posix.js';

/** `Created`: creation time in ms since 1601 (UTC), null when Windows does not report it. */
interface ProcessRow { ProcessId: number; ParentProcessId: number; CommandLine: string | null; OwnerSid?: string | null; SessionId?: number; Created?: number | null }
type Run = (file: string, args: string[]) => { status: number | null; stdout: string; error?: unknown; signal?: unknown };
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
// A cold PowerShell/CIM start can exceed five seconds on a loaded Windows host.
// Keep inspection bounded without extending the separate process-kill deadline.
const run: Run = (file, args) => spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: file === powershell ? 15_000 : 5000, maxBuffer: 32 * 1024 * 1024 });

function inspectionFailure(stage: string, result: ReturnType<Run>, started: number): void {
  const rawCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : result.error ? 'unknown' : 'none';
  const signal = typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal) ? result.signal : 'none';
  // CIM output contains other processes' command lines. Report only metadata;
  // neither process output nor error messages are safe diagnostic payloads.
  console.error(`[clivoxa] Windows process inspection failed: stage=${stage}, status=${result.status}, code=${code}, signal=${signal}, elapsed_ms=${Date.now() - started}, stdout_bytes=${Buffer.byteLength(result.stdout ?? '', 'utf8')}`);
}

/**
 * Shell processes that legitimately start user apps from a session-0 service (see ancestorCommands).
 * Windows Terminal is COM-activated (`-Embedding`, parent svchost DcomLaunch) when it is the default
 * terminal on Windows 11; it is no wider a door than Explorer, which starts programs the same way.
 */
const SHELL_HOSTS = new Set(['sihost.exe', 'explorer.exe', 'windowsterminal.exe']);

/** Lower-case executable file name of a Windows command line. */
function executableName(commandLine: string): string {
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(commandLine);
  return (m?.[1] ?? m?.[2] ?? '').replace(/^.*[\\/]/, '').toLowerCase();
}

function processRows(data: unknown): ProcessRow[] | null {
  return Array.isArray(data) && data.every((r) => Number.isSafeInteger(r?.ProcessId) && Number.isSafeInteger(r?.ParentProcessId) && (r.CommandLine === null || typeof r.CommandLine === 'string') && (r.SessionId === undefined || Number.isSafeInteger(r.SessionId)) && (r.Created === undefined || r.Created === null || Number.isSafeInteger(r.Created))) ? data : null;
}

/**
 * Windows keeps a dead parent's id in ParentProcessId and reuses ids quickly, so an unrelated process
 * can name a job's pid as its parent. A real child is never older than its parent.
 */
function childOf(child: ProcessRow, parent: ProcessRow | undefined): boolean {
  if (child.ParentProcessId !== parent?.ProcessId) return false;
  return typeof child.Created !== 'number' || typeof parent.Created !== 'number' || child.Created >= parent.Created;
}

// Resolve ownership only along our ancestry and only when its command line is inaccessible.
// PowerShell's parent is this Node process. Ordinary liveness/tree snapshots need no SID calls.
const ancestryScript = `
$ErrorActionPreference="Stop";
[Console]::OutputEncoding=[Text.Encoding]::UTF8;
Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop;
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$processes=@(Get-CimInstance Win32_Process);
$byId=@{};
foreach ($item in $processes) { $byId[[int]$item.ProcessId]=$item; }
$currentSession=[int]$byId[[int]$PID].SessionId;
$owners=@{};
$seen=@{};
$cursorId=[int]$byId[[int]$PID].ParentProcessId;
for ($step=0; $step -lt 65 -and $cursorId -gt 1; $step++) {
  if ($seen.ContainsKey($cursorId) -or !$byId.ContainsKey($cursorId)) { break; }
  $seen[$cursorId]=$true;
  $item=$byId[$cursorId];
  if ($currentSession -ne 0 -and [int]$item.SessionId -eq 0) { break; }
  if ($null -eq $item.CommandLine) {
    try {
      $owner=Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -ErrorAction Stop;
      if ($owner.ReturnValue -eq 0 -and $owner.Sid) {
        $owners[$cursorId]=$owner.Sid;
        if ($owner.Sid -ne $currentSid) { break; }
      }
    } catch {}
  }
  $cursorId=[int]$item.ParentProcessId;
}
$rows=@(foreach ($item in $processes) {
  [pscustomobject]@{ProcessId=[int]$item.ProcessId;ParentProcessId=[int]$item.ParentProcessId;CommandLine=$item.CommandLine;OwnerSid=$owners[[int]$item.ProcessId];SessionId=[int]$item.SessionId}
});
[pscustomobject]@{CurrentSid=$currentSid;CurrentSessionId=$currentSession;Processes=$rows} | ConvertTo-Json -Depth 4 -Compress;
`;

/** Static PowerShell only; caller data never becomes a script. */
export function createWindowsProcesses(exec: Run = run, kill: typeof process.kill = process.kill.bind(process)) {
  const exists = (pid: number): 'exists' | 'gone' | 'unknown' => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return 'gone';
    try { kill(pid, 0); return 'exists'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'; }
  };
  const rows = (): ProcessRow[] | null => {
    const started = Date.now();
    const result = exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Import-Module (Join-Path $PSHOME "Modules/CimCmdlets/CimCmdlets.psd1") -ErrorAction Stop; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name="Created";Expression={if ($_.CreationDate) { [long][math]::Floor($_.CreationDate.ToFileTimeUtc() / 10000) } else { $null }}}) -Compress']);
    if (result.status !== 0 || result.error || result.signal) {
      inspectionFailure('snapshot-command', result, started);
      return null;
    }
    try {
      const data: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
      const processes = processRows(data);
      if (!processes) inspectionFailure('snapshot-shape', result, started);
      return processes;
    } catch { inspectionFailure('snapshot-json', result, started); return null; }
  };
  return {
    probe(pid: number, marker: string): Liveness {
      if (exists(pid) === 'gone') return 'dead';
      const processes = rows();
      if (!processes) return 'unknown';
      const row = processes.find((r) => r.ProcessId === pid);
      if (!row) {
        if (exists(pid) === 'gone') return 'dead';
        console.error(`[clivoxa] Windows process inspection: pid=${pid}, reason=missing-from-snapshot`);
        return 'unknown';
      }
      if (row.CommandLine === null) {
        console.error(`[clivoxa] Windows process inspection: pid=${pid}, reason=command-line-unavailable`);
        return 'unknown';
      }
      return row.CommandLine.includes(marker) ? 'alive' : 'dead';
    },
    descendants(roots: number[], _groups: number[] = []): number[] {
      const processes = rows();
      if (!processes) return [];
      const byPid = new Map(processes.map((row) => [row.ProcessId, row]));
      const found = new Set(roots);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of processes) {
          if (found.has(row.ProcessId) || !found.has(row.ParentProcessId) || !childOf(row, byPid.get(row.ParentProcessId))) continue;
          found.add(row.ProcessId);
          changed = true;
        }
      }
      return [...found].filter((pid) => !roots.includes(pid) && pid !== process.pid);
    },
    /**
     * Each listed pid only, without /T: taskkill's own tree walk follows the same stale parent ids,
     * so callers pass the tree from descendants(), which checks them.
     */
    signalAll(pids: number[], signal: NodeJS.Signals): void {
      for (const pid of new Set(pids)) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
        exec(taskkill, ['/PID', String(pid), ...(signal === 'SIGKILL' ? ['/F'] : [])]);
      }
    },
    isGone(pid: number): boolean { return exists(pid) === 'gone'; },
    /**
     * PowerShell's language mode, or null when it cannot be read. WDAC and AppLocker enforce
     * ConstrainedLanguage, where the .NET calls in the scripts above are refused; reading the
     * mode itself works in every mode that runs scripts at all.
     */
    languageMode(): string | null {
      const result = exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ExecutionContext.SessionState.LanguageMode']);
      const mode = result.status === 0 && !result.error && !result.signal ? (result.stdout ?? '').trim() : '';
      return /^(FullLanguage|ConstrainedLanguage|RestrictedLanguage|NoLanguage)$/.test(mode) ? mode : null;
    },
    ancestorCommands(): string[] | null {
      const started = Date.now();
      const result = exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ancestryScript]);
      if (result.status !== 0 || result.error || result.signal) {
        inspectionFailure('ancestry-command', result, started);
        return null;
      }
      let processes: ProcessRow[] | null;
      let currentSid: string;
      let currentSession: number | null = null;
      try {
        const data: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
        if (!data || typeof data !== 'object' || !('CurrentSid' in data) || typeof data.CurrentSid !== 'string' || !/^S-\d+(?:-\d+)+$/.test(data.CurrentSid) || !('Processes' in data)) {
          inspectionFailure('ancestry-shape', result, started);
          return null;
        }
        currentSid = data.CurrentSid;
        if ('CurrentSessionId' in data && Number.isSafeInteger(data.CurrentSessionId) && (data.CurrentSessionId as number) >= 0) currentSession = data.CurrentSessionId as number;
        processes = processRows(data.Processes);
      } catch { inspectionFailure('ancestry-json', result, started); return null; }
      if (!processes) { inspectionFailure('ancestry-rows', result, started); return null; }
      const map = new Map(processes.map((r) => [r.ProcessId, r]));
      const commands: string[] = [];
      const visited = new Set<number>();
      for (let pid = process.ppid; pid > 1 && commands.length < 64;) {
        if (visited.has(pid)) return null;
        visited.add(pid);
        const row = map.get(pid);
        if (!row) break;
        // Session 0 holds only Windows services. Our runner always lives in the
        // user's desktop session, so a session-0 ancestor ends the user's ancestry,
        // but only when the shell started that branch (sihost for MSIX apps,
        // explorer's COM factory): a service-launched branch such as Task Scheduler
        // or WMI could otherwise launder a sub-agent's ancestry. A readable command
        // line there is still checked.
        if (currentSession !== null && currentSession !== 0 && row.SessionId === 0) {
          const shellStarted = commands.length > 0 && SHELL_HOSTS.has(executableName(commands[commands.length - 1]!));
          if (!shellStarted) return null;
          if (row.CommandLine !== null) commands.push(row.CommandLine);
          break;
        }
        if (row.CommandLine === null) {
          // A proven foreign owner ends the current user's process ancestry. A missing
          // command line with the same or unknown owner still cannot establish safety.
          if (typeof row.OwnerSid === 'string' && /^S-\d+(?:-\d+)+$/.test(row.OwnerSid) && row.OwnerSid !== currentSid) break;
          console.error('[clivoxa] Windows process inspection: ancestor command unavailable; owner is same or unknown.');
          return null;
        }
        commands.push(row.CommandLine);
        pid = row.ParentProcessId;
      }
      return commands;
    },
  };
}
/** Owner and DACL of a directory (SDDL) and the current user's SID, as read by Windows PowerShell. */
export interface DirectorySecurity { sddl: string; userSid: string }

/** The security descriptor of `dir`; null when it cannot be read. The path travels in the environment, never in the script. */
export function directorySecurity(dir: string): DirectorySecurity | null {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; (Get-Acl -LiteralPath $env:CLIVOXA_ACL_DIR).Sddl'],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, CLIVOXA_ACL_DIR: dir } });
  if (result.status !== 0 || result.error || result.signal) return null;
  const [userSid, sddl] = (result.stdout ?? '').replace(/^﻿/, '').split(/\r?\n/).map((line) => line.trim());
  return userSid && /^S-\d+(?:-\d+)+$/.test(userSid) && sddl?.startsWith('O:') ? { sddl, userSid } : null;
}

const native = createWindowsProcesses();
export const { probe, descendants, signalAll, isGone, ancestorCommands, languageMode } = native;
