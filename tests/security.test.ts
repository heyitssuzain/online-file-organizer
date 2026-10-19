/** Regression tests for the security-fix wave 1 (see SECURITY_FIX_REPORT.md). */
import { describe, expect, it } from 'vitest';
import { buildPlan, destinationPath, DEFAULT_OPTIONS, PlanEntry } from '../src/core/plan.js';
import { csvEscape, sanitizeDownloadName, toCsv } from '../src/core/export.js';

const file = (name: string, size = 10): File => new File(['x'.repeat(size)], name, { type: 'application/octet-stream' });

const HOSTILE_NAMES = [
  'a.<img src=x onerror=alert(1)>',
  'malicious.\'" onload=alert(1)>',
  'a.<svg><animate onbegin=alert(1)>',
  'weird.&"><script>.doc',
  '.<>&:"/\\|?*', // all Windows-hostile chars as extension body
];

describe('plan: hostile extensions are neutralized (XSS / path safety)', () => {
  it('extension-rule folder names contain no HTML metacharacters or path separators', () => {
    for (const name of HOSTILE_NAMES) {
      const plan = buildPlan([file(name)], { ...DEFAULT_OPTIONS, rule: 'extension' });
      const entry = plan.entries[0]!;
      expect(entry.skip).toBeNull();
      for (const folder of entry.destination) {
        // HTML-sensitive + path separators must never appear; a lone apostrophe
        // is legal on Windows/macOS/Linux folder names and is escaped at render.
        expect(folder).not.toMatch(/[<>"\/\\|:*?]/);
        expect(folder).not.toMatch(/[\u0000-\u001f]/);
      }
    }
  });

  it('hostile-extension files still organize (not skipped) into Others with a safe folder', () => {
    const plan = buildPlan([file('a.<img src=x onerror=alert(1)>')], { ...DEFAULT_OPTIONS, rule: 'extension' });
    const e = plan.entries[0]!;
    expect(e.category).toBe('Others');
    expect(plan.organizedFiles).toBe(1);
  });

  it('ZIP / manifest destinationPath segments stay portable for hostile names', () => {
    for (const name of HOSTILE_NAMES) {
      const plan = buildPlan([file(name)], { ...DEFAULT_OPTIONS, rule: 'extension' });
      const entry = plan.entries[0] as PlanEntry;
      const path = destinationPath(entry);
      for (const segment of path.split('/')) {
        expect(segment).not.toMatch(/[<>:"|?*\u0000-\u001f]/); // sanitized per segment
      }
      expect(path.split('/')).toHaveLength(3); // ext folder / category folder / name — no traversal
    }
  });

  it('type rule is unaffected and collisions still resolve', () => {
    const plan = buildPlan([file('a.pdf'), file('a.pdf')], { ...DEFAULT_OPTIONS, rule: 'type' });
    expect(plan.conflictsResolved).toBe(1);
    expect(plan.entries[1]!.finalName).toBe('a_1.pdf');
  });
});

describe('CSV export: formula injection neutralized', () => {
  const dangerous = ['=cmd|"calc"!a1', '+SUM(1,1)', '-1+0', '@SUM(1)', '\t=1', '\r=1'];
  it('prefixes a literal apostrophe before formula-leading characters', () => {
    for (const value of dangerous) {
      const escaped = csvEscape(value);
      //Quoting may wrap the cell — unwrap, then the apostrophe must be first.
      const bare = escaped.startsWith('"') ? escaped.slice(1) : escaped;
      expect(bare.startsWith("'")).toBe(true);
    }
  });
  it('plain names and normal quoting are unchanged', () => {
    expect(csvEscape('report.pdf')).toBe('report.pdf');
    expect(csvEscape('name, with comma')).toBe('"name, with comma"');
    expect(csvEscape('quote " inside')).toBe('"quote "" inside"');
  });
  it('a full CSV row from hostile filenames never executes as a formula', () => {
    const csv = toCsv([
      ['original_name', 'proposed_destination'],
      ...HOSTILE_NAMES.map((n) => [n, n.replace(/<ext>/, 'x')]),
    ]);
    for (const line of csv.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(cell.startsWith('=')).toBe(false);
        expect(cell.startsWith('@')).toBe(false);
      }
    }
  });
});

describe('download names stay safe', () => {
  it('sanitizeDownloadName strips hostiles and never returns empty', () => {
    expect(sanitizeDownloadName('a<b>.zip')).toBe('a_b_.zip');
    expect(sanitizeDownloadName('')).toBe('download');
    expect(sanitizeDownloadName('..weird:name?.txt')).toBe('..weird_name_.txt');
  });
});
