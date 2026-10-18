import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Locations of this installation, resolved from this module itself and never from caller argv.
 * The published package is a single bundle (dist/clivoxa.mjs); development and test builds keep
 * one compiled module per source file under dist/.
 */
const self = fileURLToPath(import.meta.url);
const bundled = path.basename(self) === 'clivoxa.mjs';
const distDir = bundled ? path.dirname(self) : path.resolve(path.dirname(self), '..');

/** Root of the installed package (the directory holding dist/ and scripts/lib/). */
export function packageRoot(): string { return path.dirname(distDir); }
export function cliScript(): string { return bundled ? self : path.join(distDir, 'cli', 'main.js'); }
export function jobRunnerScript(): string { return bundled ? self : path.join(distDir, 'runner', 'main.js'); }
/** Helper modules shipped next to dist/ (sandbox verifiers run by the doctor and the runner). */
export function packageScriptUrl(name: string): string { return pathToFileURL(path.join(packageRoot(), 'scripts', 'lib', name)).href; }
