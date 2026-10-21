/**
 * AuraFlow Web — local data conversion
 *
 * CSV/TSV parsing, JSON shaping and a compact OOXML (.xlsx) writer. No network
 * calls, no spreadsheet dependency, no formula execution. XLSX output is
 * intentionally one-way: reading arbitrary Excel workbooks reliably needs a
 * much larger parser than this toolkit can justify.
 */

import { buildZip, type ZipEntry } from './zip.js';

export type Delimiter = ',' | '\t' | ';';

export interface ObjectRow {
  [key: string]: string;
}

export const MAX_DATA_ROWS = 50_000;
export const MAX_DATA_COLUMNS = 300;

/** Remove a UTF-8 BOM and normalise line endings outside quoted fields later. */
export function cleanText(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** Guess the delimiter from the first logical line, respecting quotes. */
export function detectDelimiter(text: string): Delimiter {
  const sample = cleanText(text).slice(0, 8192);
  let inQuotes = false;
  let counts: Record<Delimiter, number> = { ',': 0, '\t': 0, ';': 0 };
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i]!;
    if (ch === '"') {
      if (inQuotes && sample[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      break;
    } else if (!inQuotes && (ch === ',' || ch === '\t' || ch === ';')) {
      counts[ch]++;
    }
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as Delimiter | undefined) ?? ',';
}

/** RFC-4180-ish parser; supports quoted delimiters, doubled quotes and newlines. */
export function parseDelimited(text: string, delimiter?: Delimiter): string[][] {
  const src = cleanText(text);
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let touched = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      touched = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      touched = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (touched || row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      field = '';
      touched = false;
    } else {
      field += ch;
      touched = true;
    }
  }

  row.push(field);
  if (touched || row.some((v) => v.length > 0)) rows.push(row);
  return rows;
}

function uniqueHeaders(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((value, index) => {
    const base = value.trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function rowsToObjects(rows: readonly (readonly string[])[]): ObjectRow[] {
  if (rows.length === 0) return [];
  const headers = uniqueHeaders(rows[0] ?? []);
  const width = Math.min(Math.max(headers.length, 1), MAX_DATA_COLUMNS);
  if (rows.length - 1 > MAX_DATA_ROWS) {
    throw new Error(`This table has more than ${MAX_DATA_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  }
  const out: ObjectRow[] = [];
  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === '')) continue;
    const obj: ObjectRow = {};
    for (let c = 0; c < width; c++) obj[headers[c] ?? `Column ${c + 1}`] = row[c] ?? '';
    out.push(obj);
  }
  return out;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

export function objectsToRows(objects: readonly ObjectRow[]): string[][] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  if (headers.length > MAX_DATA_COLUMNS) {
    throw new Error(`This data has more than ${MAX_DATA_COLUMNS} columns. Reduce the fields first.`);
  }
  if (objects.length > MAX_DATA_ROWS) {
    throw new Error(`This data has more than ${MAX_DATA_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  }
  return [headers, ...objects.map((obj) => headers.map((h) => stringifyCell(obj[h])))];
}

/** Convert JSON text into a rectangular table, with an honest shape check. */
export function jsonToRows(text: string): string[][] {
  let value: unknown;
  try {
    value = JSON.parse(cleanText(text));
  } catch (err) {
    throw new Error(`That file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      return objectsToRows(value as ObjectRow[]);
    }
    return [['value'], ...value.map((v) => [stringifyCell(v)])];
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // A top-level array property is a common export shape: use it when it is
    // the only meaningful payload, otherwise keep the object as one row.
    const arrays = Object.values(obj).filter(Array.isArray) as unknown[][];
    if (arrays.length === 1 && arrays[0]!.length > 0) {
      const list = arrays[0]!;
      if (list.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
        return objectsToRows(list as ObjectRow[]);
      }
      return [['value'], ...list.map((v) => [stringifyCell(v)])];
    }
    return objectsToRows([Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, stringifyCell(v)]))]);
  }

  return [['value'], [stringifyCell(value)]];
}

export function rowsToCsv(rows: readonly (readonly string[])[], delimiter: Delimiter = ','): string {
  const esc = (value: string): string => {
    const lead = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]|\t/.test(lead) || (delimiter !== ',' && lead.includes(delimiter))
      ? `"${lead.replace(/"/g, '""')}"`
      : lead;
  };
  return rows.map((r) => r.map(esc).join(delimiter)).join('\r\n');
}

export function rowsToJson(rows: readonly (readonly string[])[], pretty = true): string {
  return JSON.stringify(rowsToObjects(rows), null, pretty ? 2 : 0);
}

export function csvToJson(text: string): string {
  return rowsToJson(parseDelimited(text));
}

export function csvToTsv(text: string): string {
  return rowsToCsv(parseDelimited(text), '\t');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function looksNumeric(value: string): boolean {
  // Preserve leading-zero identifiers (ZIP codes, phone numbers) as text.
  if (value.length > 1 && value.startsWith('0') && /^0[0-9]+$/.test(value)) return false;
  return value.length > 0 && value.length < 16 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
}

function sheetXml(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          const raw = String(value ?? '');
          if (looksNumeric(raw)) {
            return `<c r="${ref}"><v>${raw}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function blobText(content: string): Blob {
  return new Blob([content], { type: 'application/xml' });
}

/**
 * Build a minimal valid XLSX (OOXML) workbook from a rectangular table.
 * Strings are always inline strings, so values beginning with `=` are never
 * interpreted as formulas by Excel/LibreOffice.
 */
export async function rowsToXlsx(rows: readonly (readonly string[])[], sheetName = 'Sheet1'): Promise<Uint8Array> {
  if (rows.length > MAX_DATA_ROWS + 1) {
    throw new Error(`This table has more than ${MAX_DATA_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  }
  if (rows.some((r) => r.length > MAX_DATA_COLUMNS)) {
    throw new Error(`This table has more than ${MAX_DATA_COLUMNS} columns. Reduce the fields first.`);
  }
  const safeSheet = escapeXml((sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 31)) || 'Sheet1';
  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      file: blobText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      path: '_rels/.rels',
      file: blobText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      path: 'xl/workbook.xml',
      file: blobText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      file: blobText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    {
      path: 'xl/styles.xml',
      file: blobText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`),
    },
    { path: 'xl/worksheets/sheet1.xml', file: blobText(sheetXml(rows)) },
  ];
  const { blob } = await buildZip(entries);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Read a text-like blob with a hard cap so a huge file can't lock the tab. */
export async function readTextLimited(file: Blob, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(`Text files are limited to ${Math.round(maxBytes / (1024 * 1024))} MB in this browser tool.`);
  }
  return file.text();
}
