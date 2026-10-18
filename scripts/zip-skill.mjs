#!/usr/bin/env node
// dist-skills/clivoxa-codex-ile-calis.zip: Claude uygulamasına (Ayarlar > Skills) yüklenecek skill paketi.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_UPLOAD_LINT, lintSkill, writeZip, zipEntries } from './lib/skill-zip.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = path.join(ROOT, 'skills', 'clivoxa-codex-ile-calis', 'SKILL.md');
const text = fs.readFileSync(src, 'utf8');
const errs = lintSkill(text, CLAUDE_UPLOAD_LINT);
if (errs.length) {
  console.error(`SKILL.md hataları:\n  - ${errs.join('\n  - ')}`);
  process.exit(1);
}
const args = process.argv.slice(2);
const outDir = args.includes('--out-dir') ? path.resolve(args[args.indexOf('--out-dir') + 1]) : path.join(ROOT, 'dist-skills');
const out = path.join(outDir, 'clivoxa-codex-ile-calis.zip');
writeZip(out, [{ name: 'clivoxa-codex-ile-calis/' }, { name: 'clivoxa-codex-ile-calis/SKILL.md', data: Buffer.from(text, 'utf8') }]);
const names = zipEntries(out);
if (JSON.stringify(names) !== JSON.stringify(['clivoxa-codex-ile-calis/', 'clivoxa-codex-ile-calis/SKILL.md'])) {
  console.error(`zip içeriği beklenmedik: ${names.join(', ')}`);
  process.exit(1);
}
console.log(`Skill zip: ${out}`);
