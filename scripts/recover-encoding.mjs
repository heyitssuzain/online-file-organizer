/**
 * Recovery v2 (correct): earlier PowerShell edits read UTF-8 HTML as ANSI
 * (cp1252) and re-wrote it as UTF-8 — corrupting high characters in every page.
 *
 * Corruption chain:   B (valid utf8 bytes) --cp1252-decode--> text (mojibake)
 *                     --utf8-encode--> current file C
 *
 * Reverse (exact, needs a true cp1252 ENCODE for the 0x80–0x9F specials,
 * because U+20AC etc. exist only in cp1252, not latin1):
 *   text2 = utf8decode(C)          // = mojibake text
 *   B     = cp1252encode(text2)    // back to original byte stream
 *   orig  = utf8decode(B)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// WHATWG windows-1252 data (the bytes .NET/PS handed to real characters).
const SPECIAL = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);
const UNICODE_TO_BYTE = new Map([...SPECIAL].map(([b, u]) => [u, b]));

function cp1252encode(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const mapped = UNICODE_TO_BYTE.get(code);
    if (mapped !== undefined) out.push(mapped);
    else if (code <= 0xff) out.push(code); // latin1 passthrough (covers 0x81 0x8d …)
    else out.push(0x3f); // '?' — would mean the corruption was lossier than assumed
  }
  return Buffer.from(out);
}

const files = [
  ...readdirSync('.').filter((f) => f.endsWith('.html')),
  ...readdirSync('guides').map((f) => `guides/${f}`).filter((f) => f.endsWith('.html')),
];

const MOJIBAKE = /â€|Ã[\x80-\xbf]?|Â[\x80-\xbf]?|ð[\x9f\x9d]?/;
let recovered = 0;

for (const rel of files) {
  const bytes = readFileSync(rel);
  if (!bytes.includes(0xc3) && !bytes.includes(0xc2)) continue; // no UTF-8 multibyte → untouched

  const text2 = bytes.toString('utf8');
  if (!MOJIBAKE.test(text2)) continue;

  const B = cp1252encode(text2);
  const orig = B.toString('utf8');
  const clean = !MOJIBAKE.test(orig) && !orig.includes('\ufffd');

  if (!clean) {
    console.log(`!!!!!!!! ${rel}: recovery produced residual artifacts — NOT saved`);
    continue;
  }
  writeFileSync(rel, B); // exact original bytes, no BOM
  recovered++;
  console.log(`recovered: ${rel} (${bytes.length} → ${B.length} bytes)`);
}

console.log(`\nDone: ${recovered} file(s) restored.`);
