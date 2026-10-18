// Removes dist/ before a build so modules deleted or moved in src/ never linger in the package,
// in installed runtimes (which copy dist/) or in the per-module test imports.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
fs.rmSync(fileURLToPath(new URL('../dist', import.meta.url)), {recursive: true, force: true});
