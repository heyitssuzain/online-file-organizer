import { describe, expect, it } from 'vitest';
import {
  columnName,
  csvToJson,
  csvToTsv,
  detectDelimiter,
  jsonToRows,
  objectsToRows,
  parseDelimited,
  rowsToCsv,
  rowsToJson,
  rowsToObjects,
  rowsToXlsx,
} from '../src/core/data-convert.js';

/** Minimal reader for the stored (method 0) ZIPs produced by our own writer. */
function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    files.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return files;
}

describe('CSV / TSV parsing', () => {
  it('handles BOMs, quoted commas, doubled quotes and embedded newlines', () => {
    const rows = parseDelimited(
      '\uFEFFname,note\r\nAda,"likes, tea"\r\nGrace,"said ""hi"""\r\nLin,"line one\nline two"\r\n',
    );
    expect(rows).toEqual([
      ['name', 'note'],
      ['Ada', 'likes, tea'],
      ['Grace', 'said "hi"'],
      ['Lin', 'line one\nline two'],
    ]);
  });

  it('detects tab and semicolon delimiters', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('"a,b";c\n1;2')).toBe(';');
  });

  it('does not create a trailing blank row', () => {
    expect(parseDelimited('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('makes duplicate/empty headers unique and drops fully blank rows', () => {
    const rows = rowsToObjects([
      ['name', 'name', ''],
      ['Ada', 'Lovelace', 'x'],
      ['', '', ''],
      ['Grace', 'Hopper', 'y'],
    ]);
    expect(rows).toEqual([
      { name: 'Ada', name_2: 'Lovelace', 'Column 3': 'x' },
      { name: 'Grace', name_2: 'Hopper', 'Column 3': 'y' },
    ]);
  });
});

describe('JSON shaping', () => {
  it('converts arrays of objects and unions their keys', () => {
    const rows = jsonToRows('[{"a":1,"b":2},{"b":3,"c":4}]');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['', '3', '4'],
    ]);
  });

  it('converts arrays of primitives to a value column', () => {
    expect(jsonToRows('[1, "two", true]')).toEqual([
      ['value'],
      ['1'],
      ['two'],
      ['true'],
    ]);
  });

  it('unwraps a single top-level array payload', () => {
    expect(jsonToRows('{"items":[{"id":1},{"id":2}],"count":2}')).toEqual([
      ['id'],
      ['1'],
      ['2'],
    ]);
  });

  it('keeps a flat object as one row', () => {
    expect(jsonToRows('{"name":"Ada","age":36}')).toEqual([
      ['name', 'age'],
      ['Ada', '36'],
    ]);
  });

  it('reports malformed JSON clearly', () => {
    expect(() => jsonToRows('{nope')).toThrow(/not valid JSON/i);
  });

  it('round-trips CSV to JSON objects', () => {
    const json = JSON.parse(csvToJson('name,age\nAda,36\nGrace,45\n'));
    expect(json).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '45' },
    ]);
  });

  it('converts delimiters without re-quoting plain cells', () => {
    expect(csvToTsv('a,b\n1,2')).toBe('a\tb\r\n1\t2');
  });
});

describe('CSV writing safety', () => {
  it('neutralises formula-leading cells', () => {
    const csv = rowsToCsv([
      ['=cmd|calc', '+SUM(1,1)', '-1+0', '@SUM(1)'],
    ]);
    expect(csv.startsWith("'=cmd|calc")).toBe(true);
    expect(csv).toContain("'+SUM(1,1)");
    expect(csv).toContain("'-1+0");
    expect(csv).toContain("'@SUM(1)");
  });

  it('preserves leading-zero identifiers as text in JSON output', () => {
    expect(objectsToRows([{ zip: '00123', count: '4' }])).toEqual([
      ['zip', 'count'],
      ['00123', '4'],
    ]);
    expect(JSON.parse(rowsToJson([['zip'], ['00123']]))).toEqual([{ zip: '00123' }]);
  });
});

describe('XLSX writer', () => {
  it('produces a valid stored OOXML package with inline strings', async () => {
    const bytes = await rowsToXlsx(
      [
        ['name', 'score', 'zip', 'formula'],
        ['Ada', '42', '00123', '=1+1'],
        ['Grace & Hopper', '7.5', '0042', '<script>'],
      ],
      'People & Things',
    );
    expect(bytes.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));

    const files = readStoredZip(bytes);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(files.get('xl/workbook.xml')).toContain('People &amp; Things');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<v>42</v>');
    expect(sheet).toContain('<v>7.5</v>');
    expect(sheet).toContain('00123');
    expect(sheet).toContain('0042');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=1+1');
    expect(sheet).toContain('&lt;script&gt;');
    expect(sheet).not.toContain('<f>');
  });

  it('names columns correctly past Z', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });
});
