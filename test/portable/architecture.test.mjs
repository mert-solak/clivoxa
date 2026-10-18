import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

// Each layer may import only from the layers listed for it. Leaves import nothing in src/.
const ALLOWED = {
  domain: [],
  shared: [],
  system: [],
  config: ['domain', 'system'],
  security: ['domain', 'shared', 'system', 'config'],
  providers: ['domain', 'shared', 'system', 'config', 'security'],
  jobs: ['domain', 'shared', 'system', 'config', 'security', 'providers'],
  runner: ['domain', 'shared', 'system', 'config', 'security', 'providers', 'jobs'],
  mcp: ['domain', 'shared', 'system', 'config', 'security', 'providers', 'jobs'],
  setup: ['domain', 'shared', 'system', 'config', 'security', 'providers'],
  cli: ['domain', 'shared', 'system', 'config', 'security', 'providers', 'jobs', 'runner', 'mcp', 'setup'],
};
// The root entry is kept for the test harness and the smoke check (dist/index.js).
const ENTRY_SHIMS = {'index.ts': ['./mcp/server.js']};
// Built-in modules the side-effect-free domain layer may use (ids are random).
const DOMAIN_BUILTINS = ['node:crypto'];
// Modules that load shipped helper scripts by computed URL (scripts/lib verifiers).
const COMPUTED_IMPORTS = ['providers/verification.ts'];

const sources = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
});
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');
const layerOf = (file) => rel(file).split('/')[0];
/** Every module specifier the TypeScript scanner sees: import/export from, side-effect and literal dynamic imports. */
const specifiers = (text) => ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);

test('source modules follow the layer order', () => {
  const violations = [];
  for (const file of sources(SRC)) {
    const from = layerOf(file);
    const text = fs.readFileSync(file, 'utf8');
    const specs = specifiers(text);
    if (rel(file) in ENTRY_SHIMS) {
      // The dist/index.js entry only forwards to its layer.
      assert.deepEqual(specs, ENTRY_SHIMS[rel(file)], `src/${rel(file)} may only forward to ${ENTRY_SHIMS[rel(file)]}`);
      continue;
    }
    assert.ok(from in ALLOWED, `${rel(file)} is outside every known layer`);
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const to = layerOf(path.resolve(path.dirname(file), spec));
        if (to !== from && !ALLOWED[from].includes(to)) violations.push(`${rel(file)} -> ${spec}`);
      } else if (from === 'domain' && !DOMAIN_BUILTINS.includes(spec)) {
        violations.push(`${rel(file)} -> ${spec} (domain must stay free of I/O and dependencies)`);
      }
    }
    if (/\brequire\s*\(|\bcreateRequire\b/.test(text)) violations.push(`${rel(file)} uses require()`);
    if (/\bimport\s*\(\s*[^'"`\s)]/.test(text) && !COMPUTED_IMPORTS.includes(rel(file))) {
      violations.push(`${rel(file)} imports a computed module path`);
    }
  }
  assert.deepEqual(violations, []);
});
