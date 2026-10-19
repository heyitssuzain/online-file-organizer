import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, buildPlan, destinationPath, formatBytes } from '../src/core/plan.js';
import type { OrganizeRule } from '../src/core/plan.js';

/** Tiny File stand-in with controllable name/size/lastModified (Node-compatible). */
function mkFile(name: string, size = 100, lastModified = Date.UTC(2025, 3, 15)): File {
  const f = { name, size, lastModified, type: '' } as unknown as File;
  return f;
}

const opts = (over: Partial<{ rule: OrganizeRule; excludeTemp: boolean; excludeSystem: boolean; excludePatterns: string[]; onlyCategories: string[] | null }> = {}) => ({
  ...DEFAULT_OPTIONS,
  ...over,
});

describe('buildPlan — categorisation', () => {
  it('groups files into categories and skips temp/system files', () => {
    const plan = buildPlan(
      [
        mkFile('resume.pdf'),
        mkFile('holiday.png', 500),
        mkFile('setup.exe.crdownload', 50),
        mkFile('Thumbs.db', 20),
        mkFile('data.xyzzy', 10),
      ],
      opts(),
    );

    expect(plan.totalFiles).toBe(5);
    expect(plan.tempCount).toBe(1);
    expect(plan.systemCount).toBe(1);
    expect(plan.organizedFiles).toBe(3); // pdf, png, xyzzy
    expect(plan.byCategory.get('Documents')?.length).toBe(1);
    expect(plan.byCategory.get('Images')?.length).toBe(1);
    expect(plan.byCategory.get('Others')?.length).toBe(1);
    expect(plan.unknownExtensions.has('.xyzzy')).toBe(true);
  });

  it('empty selection yields an empty plan, not an error', () => {
    const plan = buildPlan([], opts());
    expect(plan.totalFiles).toBe(0);
    expect(plan.organizedFiles).toBe(0);
    expect(plan.byCategory.size).toBe(0);
  });

  it('uppercase extensions categorise normally', () => {
    const plan = buildPlan([mkFile('SCAN.PDF')], opts());
    expect(destinationPath(plan.entries[0]!)).toBe('Documents/SCAN.PDF');
  });
});

describe('buildPlan — rules', () => {
  it("rule 'type' routes by category folder", () => {
    const plan = buildPlan([mkFile('a.mp4')], opts({ rule: 'type' }));
    expect(destinationPath(plan.entries[0]!)).toBe('Videos/a.mp4');
  });

  it("rule 'extension' routes by extension folder", () => {
    const plan = buildPlan([mkFile('a.mp4'), mkFile('noext')], opts({ rule: 'extension' }));
    expect(destinationPath(plan.entries[0]!)).toBe('Videos/mp4/a.mp4');
    expect(destinationPath(plan.entries[1]!)).toBe('Others/no-extension/noext');
  });

  it("rule 'date' routes by last-modified month then type", () => {
    const d = Date.UTC(2025, 0, 9); // 2025-01
    const plan = buildPlan([mkFile('a.mp3', 1, d)], opts({ rule: 'date' }));
    expect(destinationPath(plan.entries[0]!)).toBe('2025-01/Audio/a.mp3');
  });

  it('category filter keeps skipped records rather than discarding silently', () => {
    const plan = buildPlan([mkFile('song.mp3'), mkFile('doc.pdf')], opts({ onlyCategories: ['Documents'] }));
    expect(plan.organizedFiles).toBe(1);
    const songEntry = plan.entries.find((e) => e.name === 'song.mp3')!;
    expect(songEntry.skip).toBe('category-filter');
    expect(plan.byCategory.has('Audio')).toBe(false);
  });

  it('exclusion patterns remove matching files but keep them visible as skipped', () => {
    const plan = buildPlan([mkFile('keep.jpg'), mkFile('skip-me.tmpf')], opts({ excludePatterns: ['skip-*'] }));
    expect(plan.organizedFiles).toBe(1);
    expect(plan.patternExcluded).toBe(1);
  });
});

describe('buildPlan — collision safety (never overwrite)', () => {
  it('renames in-plan collisions sequentially', () => {
    const plan = buildPlan([mkFile('a.pdf', 10), mkFile('a.pdf', 20)], opts());
    const names = plan.entries.filter((e) => !e.skip).map((e) => e.finalName);
    expect(names.sort()).toEqual(['a.pdf', 'a_1.pdf']);
    expect(plan.conflictsResolved).toBe(1);
  });

  it('renames against files that already exist on disk', () => {
    const existing = new Map([['Documents', new Set(['a.pdf'])]]);
    const plan = buildPlan([mkFile('a.pdf')], opts(), existing);
    expect(plan.entries[0]!.finalName).toBe('a_1.pdf');
    expect(plan.conflictsResolved).toBe(1);
  });

  it('treats two same-name files in different source folders as a collision too', () => {
    const f1 = mkFile('report.pdf');
    const f2 = mkFile('report.pdf');
    const plan = buildPlan([f1, f2], opts());
    const finals = plan.entries.filter((e) => !e.skip).map((e) => e.finalName);
    expect(new Set(finals).size).toBe(2);
  });

  it('sanitised names feed collision detection', () => {
    const plan = buildPlan([mkFile('we?ird.pdf'), mkFile('weird.pdf')], opts());
    const finals = plan.entries.filter((e) => !e.skip).map((e) => e.finalName);
    expect(finals).toContain('we_ird.pdf');
    expect(new Set(finals).size).toBe(2);
  });
});

describe('formatBytes (desktop format parity)', () => {
  it('formats human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});
