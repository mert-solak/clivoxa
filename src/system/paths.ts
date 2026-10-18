import fs from 'node:fs';
import path from 'node:path';

/** macOS (default APFS) and Windows (NTFS) compare paths case-insensitively. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** True if `child` is `parent` or inside it (both absolute and normalized; compared exactly). */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/** The canonical path, or the resolved input when it does not exist (yet). */
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Comparison form of a path on this platform's filesystem. */
export function caseFold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.normalize('NFC').toLowerCase() : p.normalize('NFC');
}

/** `isWithin` with this platform's case rules. */
export function within(child: string, parent: string): boolean {
  return isWithin(caseFold(child), caseFold(parent));
}
