// Lightweight secret detector / redactor.
// "high" = high-confidence token formats (always masked in returned answers).
// "all"  = high + checksummed personal/financial numbers + credential assignments
//          (applied to outgoing prompts per CLIVOXA_SECRET_POLICY and to error tails).

export type RedactLevel = 'high' | 'all';

interface Detector {
  kind: string;
  level: RedactLevel;
  re: RegExp;
  /** Optional validator on the matched text; return false to keep it. */
  check?: (m: string) => boolean;
  /** Replace only this capture group (1-based) instead of the whole match. */
  group?: number;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function isCard(m: string): boolean {
  const d = m.replace(/[ -]/g, '');
  if (/^(\d)\1+$/.test(d)) return false;
  const known =
    (/^4\d{15}$/.test(d)) || // Visa
    (/^(5[1-5]\d{14}|2(2[2-9]|[3-6]\d|7[01])\d{12}|2720\d{12})$/.test(d)) || // Mastercard
    (/^3[47]\d{13}$/.test(d)) || // Amex
    (/^9792\d{12}$/.test(d)); // Troy
  return known && luhn(d);
}

function isIban(m: string): boolean {
  const s = m.replace(/ /g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function isTckn(m: string): boolean {
  if (!/^[1-9]\d{10}$/.test(m) || /^(\d)\1+$/.test(m)) return false;
  const d = [...m].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = (d.slice(0, 10).reduce((a, b) => a + b, 0)) % 10;
  return d10 === d[9] && d11 === d[10];
}

const DETECTORS: Detector[] = [
  { kind: 'anthropic_key', level: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', level: 'high', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_access_key', level: 'high', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'aws_secret', level: 'high', re: /(aws_secret_access_key\s*[=:]\s*["']?)([A-Za-z0-9/+=]{40})/gi, group: 2 },
  { kind: 'github_token', level: 'high', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: 'google_key', level: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack_token', level: 'high', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'stripe_key', level: 'high', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'jwt', level: 'high', re: /\beyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,1024}/g },
  { kind: 'bearer_token', level: 'high', re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,4096}=*)/g, group: 2 },
  { kind: 'url_password', level: 'high', re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,256}:)([^\s@/]{3,256})(@)/gi, group: 2 },
  { kind: 'card_number', level: 'all', re: /\b\d(?:[ -]?\d){12,18}\b/g, check: isCard },
  { kind: 'iban', level: 'all', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, check: isIban },
  { kind: 'tckn', level: 'all', re: /\b[1-9]\d{10}\b/g, check: isTckn },
  {
    kind: 'credential',
    level: 'all',
    re: /((?:password|passwd|pwd|parola|şifre|sifre|secret(?:[_-]?key)?|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|token)["']?\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'`,;]{6,})/gi,
    group: 2,
  },
];

export interface RedactResult {
  text: string;
  counts: Record<string, number>;
  total: number;
}

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9 ]{1,40} )?PRIVATE KEY-----/g;
const PEM_END = /-----END (?:[A-Z0-9 ]{1,40} )?PRIVATE KEY-----/g;
/** Longest PEM block masked (an RSA-8192 key is about 6.5 KB). */
const PEM_MAX = 16 * 1024;

/** Private-key blocks, paired BEGIN→first END after it, in one linear pass. */
function redactPem(text: string, counts: Record<string, number>): string {
  const ends = [...text.matchAll(PEM_END)].map((m) => ({ at: m.index, end: m.index + m[0].length }));
  if (!ends.length) return text;
  let out = '';
  let from = 0;
  let e = 0;
  for (const m of text.matchAll(PEM_BEGIN)) {
    if (m.index < from) continue;
    while (e < ends.length && ends[e]!.at < m.index) e++;
    if (e >= ends.length) break;
    const end = ends[e]!;
    if (end.end - m.index > PEM_MAX) continue;
    out += text.slice(from, m.index) + '[GİZLİ:private_key]';
    counts.private_key = (counts.private_key ?? 0) + 1;
    from = end.end;
  }
  return out + text.slice(from);
}

export function redact(text: string, level: RedactLevel): RedactResult {
  const counts: Record<string, number> = {};
  let out = redactPem(text, counts);
  for (const d of DETECTORS) {
    if (level === 'high' && d.level !== 'high') continue;
    out = out.replace(d.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const target = d.group ? (args[d.group] as string | undefined) : match;
      if (target === undefined) return match;
      if (d.check && !d.check(target)) return match;
      if (target.startsWith('[GİZLİ:')) return match;
      counts[d.kind] = (counts[d.kind] ?? 0) + 1;
      const repl = `[GİZLİ:${d.kind}]`;
      if (!d.group) return repl;
      const idx = match.lastIndexOf(target);
      return match.slice(0, idx) + repl + match.slice(idx + target.length);
    });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out, counts, total };
}

export function detect(text: string, level: RedactLevel): Record<string, number> {
  return redact(text, level).counts;
}
