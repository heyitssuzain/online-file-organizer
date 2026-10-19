/**
 * AuraFlow Web — naming utilities
 *
 * Ported from the desktop's `utils.py` (safe_move / sanitize_filename /
 * get_unique_path). Files are never silently overwritten: when a destination
 * name is taken, `_1`, `_2`, … are appended before the extension.
 */

/** Windows-hostile characters plus control characters — makes names portable everywhere. */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeFilename(name: string): string {
  let clean = name.replace(INVALID_CHARS, '_').trim();
  // Avoid reserved-ish / empty names
  if (clean === '' || clean === '.' || clean === '..') clean = '_';
  // Tridot/ending-dot is invalid on Windows
  clean = clean.replace(/[. ]+$/g, '');
  return clean === '' ? '_' : clean;
}

export function splitName(filename: string): { stem: string; ext: string } {
  const ext = normalize(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return { stem, ext };

  function normalize(f: string): string {
    const idx = f.lastIndexOf('.');
    return idx > 0 && idx < f.length - 1 ? f.slice(idx) : '';
  }
}

/** The name the file will carry in its category folder (sanitised, extension preserved). */
export function displayMoveName(originalName: string): string {
  return sanitizeFilename(originalName);
}

/** Port of `safe_move`'s duplicate resolution: `report.pdf` → `report_1.pdf`. */
export function resolveCollision(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { stem, ext } = splitName(name);
  for (let i = 1; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
