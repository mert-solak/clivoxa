// Skill packaging helpers: a dependency-free zip writer/reader and the frontmatter lint for skills.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ------------------------------------------------------------------ zip (stored+deflate, no external tools)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a zip with the given entries [{name, data?: Buffer}] (names ending in "/" are directories). */
export function writeZip(file, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : e.data;
    const comp = isDir ? data : zlib.deflateRawSync(data);
    const method = isDir ? 0 : 8;
    const crc = isDir ? 0 : crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(((isDir ? 0o40755 : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...chunks, cd, end]));
}

/** List entry names of a zip (central directory). */
export function zipEntries(file) {
  const b = fs.readFileSync(file);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return [];
  const n = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = b.readUInt16LE(off + 28);
    const extra = b.readUInt16LE(off + 30);
    const comment = b.readUInt16LE(off + 32);
    out.push(b.subarray(off + 46, off + 46 + len).toString('utf8'));
    off += 46 + len + extra + comment;
  }
  return out;
}

// ------------------------------------------------------------------ skill frontmatter lint

/** Limits claude.ai applies to an uploaded skill (Settings > Skills). */
export const CLAUDE_UPLOAD_LINT = Object.freeze({ maxDesc: 200, forbidNameWords: ['claude', 'anthropic'] });

export function lintSkill(text, { maxDesc = 1024, forbidNameWords = [] } = {}) {
  const errs = [];
  text = text.replace(/\r\n/g, '\n'); // a Windows checkout may convert line endings
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return ['frontmatter yok'];
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      errs.push(`geçersiz satır: ${line}`);
      continue;
    }
    let v = kv[2];
    if (!/^".*"$/.test(v)) errs.push(`${kv[1]}: değer çift tırnaklı (JSON) olmalı`);
    try {
      v = JSON.parse(v);
    } catch {
      errs.push(`${kv[1]}: JSON dize değil`);
    }
    fm[kv[1]] = v;
  }
  if (!/^[a-z0-9-]{1,64}$/.test(fm.name ?? '')) errs.push('name: ^[a-z0-9-]{1,64}$ olmalı');
  for (const w of forbidNameWords) if ((fm.name ?? '').includes(w)) errs.push(`name '${w}' içeremez`);
  if (!fm.description || fm.description.length > maxDesc) errs.push(`description 1..${maxDesc} karakter olmalı`);
  return errs;
}
