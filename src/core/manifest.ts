/**
 * AuraFlow Web — operation manifest (desktop parity with `OperationTracker`)
 *
 * A manifest is the single source of truth for what an organization run did.
 * It is (a) shown in the results summary, (b) downloadable as JSON / CSV /
 * text, and (c) the information needed to explain — and, where the browser
 * allows, reverse — the changes.
 */

export interface MoveRecord {
  /** Original path relative to the organize root. */
  from: string;
  /** Destination path relative to the organize root, e.g. "Documents/a.pdf". */
  to: string;
  category: string;
  size: number;
  /** Optional honest annotation, e.g. when the browser could only copy. */
  note?: string;
}

export interface SkipRecord {
  file: string;
  reason: 'temp' | 'system' | 'pattern' | 'category-filter' | 'user-unchecked';
  detail?: string;
}

export interface ErrorRecord {
  file: string;
  message: string;
}

export interface Manifest {
  tool: 'AuraFlow Web';
  version: 1;
  createdAt: string;
  rule: string;
  root: string;
  moves: MoveRecord[];
  skipped: SkipRecord[];
  errors: ErrorRecord[];
}

export interface UndoRecord {
  /** Destination path → original path, recorded at execution time. */
  to: string;
  from: string;
}

export function createManifest(root: string, rule: string): Manifest {
  return {
    tool: 'AuraFlow Web',
    version: 1,
    createdAt: new Date().toISOString(),
    rule,
    root: root || '(selection)',
    moves: [],
    skipped: [],
    errors: [],
  };
}

/** Rows for the CSV export. */
export function manifestToRows(m: Manifest): string[][] {
  const rows: string[][] = [['original_path', 'destination_path', 'category', 'size_bytes', 'status']];
  for (const mv of m.moves) {
    rows.push([mv.from, mv.to, mv.category, String(mv.size), 'moved']);
  }
  for (const s of m.skipped) {
    rows.push([s.file, '', s.reason, '', 'skipped']);
  }
  for (const e of m.errors) {
    rows.push([e.file, '', '', '', 'error']);
  }
  return rows;
}

/** Human-readable run report, modelled on the desktop's text report. */
export function manifestToText(m: Manifest): string {
  const lines: string[] = [];
  lines.push('AuraFlow Web — Organization Report');
  lines.push(`Created: ${m.createdAt}`);
  lines.push(`Source: ${m.root}`);
  lines.push(`Rule: ${m.rule}`);
  lines.push('');
  lines.push('Moved');
  if (m.moves.length === 0) lines.push('  (none)');
  for (const mv of m.moves) lines.push(`  ${mv.from}  →  ${mv.to}`);
  if (m.skipped.length) {
    lines.push('');
    lines.push('Skipped');
    for (const s of m.skipped) lines.push(`  ${s.file}  (${s.reason})`);
  }
  if (m.errors.length) {
    lines.push('');
    lines.push('Errors');
    for (const e of m.errors) lines.push(`  ${e.file}  — ${e.message}`);
  }
  lines.push('');
  lines.push(`${m.moves.length} moved · ${m.skipped.length} skipped · ${m.errors.length} errors`);
  return lines.join('\n');
}

/** Destination folder names of moved files (top-level destination segments). */
export function foldersTouched(m: Manifest): string[] {
  return [...new Set(m.moves.map((mv) => mv.to.split('/')[0]!))];
}
