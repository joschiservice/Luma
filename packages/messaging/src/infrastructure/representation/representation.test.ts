import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { detectSeparator, parseCsv } from './csv.js';
import { represent } from './index.js';
import { serialDate } from './xlsx.js';

/** A one-page PDF with a text layer, built like the simulator's documents. */
function textPdf(lines: string[], trailer = '') {
  const stream = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '56 786 Td',
    ...lines.map((line) => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** A minimal XLSX workbook zipped in memory. */
function workbook(
  sheets: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const names = Object.keys(sheets);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map(
          (name, i) =>
            `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
        )
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships>${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ),
    ...Object.fromEntries(
      names.map((name, i) => [
        `xl/worksheets/sheet${i + 1}.xml`,
        strToU8(
          `<worksheet><sheetData>${sheets[name]}</sheetData></worksheet>`,
        ),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(extra).map(([path, xml]) => [path, strToU8(xml)]),
    ),
  };

  return zipSync(files);
}

describe('CSV', () => {
  it('detects semicolons, commas and tabs', () => {
    expect(detectSeparator('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(detectSeparator('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectSeparator('a\tb\n1\t2\n')).toBe('\t');
  });

  it('keeps quoted separators, quotes and line breaks in cells', () => {
    expect(
      parseCsv('SKU;Note\r\n"A;1";"He said ""hi""\nthen left"\r\nB;\r\n\r\n')
        .rows,
    ).toEqual([
      ['SKU', 'Note'],
      ['A;1', 'He said "hi"\nthen left'],
      ['B', ''],
    ]);
    // An unterminated quote runs to the end instead of failing.
    expect(parseCsv('a,b\n"open,1\n').rows).toEqual([['a', 'b'], ['open,1\n']]);
  });

  it('decodes UTF-8 with a byte-order mark and Windows-1252', async () => {
    const utf8 = await represent(
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Menge;Größe\n1;M\n')]),
      { format: 'csv', filename: 'plan.csv' },
    );
    expect(utf8).toEqual({
      ok: true,
      representation: {
        kind: 'sheets',
        sheets: [
          {
            name: 'plan',
            rows: [
              ['Menge', 'Größe'],
              ['1', 'M'],
            ],
          },
        ],
      },
      truncated: false,
    });
    const latin1 = await represent(
      new Uint8Array(Buffer.from('Größe;Preis\nM;12,50 \x80\n', 'latin1')),
      { format: 'csv', filename: 'plan.csv' },
    );
    expect(latin1).toMatchObject({
      ok: true,
      representation: {
        sheets: [
          {
            rows: [
              ['Größe', 'Preis'],
              ['M', '12,50 €'],
            ],
          },
        ],
      },
    });
  });

  it('cuts rows beyond the limit and says so', () => {
    const csv = Array.from({ length: 5002 }, (_, i) => `r${i}`).join('\n');
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(5000);
    expect(parsed.truncated).toBe(true);
  });
});

describe('XLSX', () => {
  it('reads shared and inline strings, numbers and dates', async () => {
    const bytes = workbook(
      {
        Plan: [
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Liefertermin</t></is></c></row>',
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>6.1000000000000005</v></c><c r="C2" s="1"><v>46315</v></c></row>',
          '<row r="4"><c r="D4" t="b"><v>1</v></c></row>',
        ].join(''),
        Leer: '',
      },
      {
        'xl/sharedStrings.xml':
          '<sst><si><t>SKU</t></si><si><r><t>Me</t></r><r><t>nge</t></r><rPh><t>x</t></rPh></si><si><t xml:space="preserve">A&amp;B</t></si></sst>',
        'xl/styles.xml':
          '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      },
    );
    const result = await represent(bytes, {
      format: 'xlsx',
      filename: 'plan.xlsx',
    });

    expect(result).toEqual({
      ok: true,
      representation: {
        kind: 'sheets',
        sheets: [
          {
            name: 'Plan',
            rows: [
              ['SKU', 'Menge', 'Liefertermin', ''],
              ['A&B', '6.1', '2026-10-20', ''],
              ['', '', '', ''],
              ['', '', '', 'TRUE'],
            ],
          },
          { name: 'Leer', rows: [] },
        ],
      },
      truncated: false,
    });
  });

  it('converts date serials in both date systems', () => {
    expect(serialDate(1, false)).toBe('1900-01-01');
    expect(serialDate(61, false)).toBe('1900-03-01');
    expect(serialDate(46315.5, false)).toBe('2026-10-20 12:00');
    expect(serialDate(0, true)).toBe('1904-01-01');
  });

  it('reports encrypted, damaged and empty workbooks as unreadable', async () => {
    const encrypted = new Uint8Array([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      ...Buffer.from('EncryptedPackage', 'utf16le'),
    ]);
    expect(
      await represent(encrypted, { format: 'xlsx', filename: 'a.xlsx' }),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'encrypted' },
    });
    expect(
      await represent(new Uint8Array(Buffer.from('PK not a zip')), {
        format: 'xlsx',
        filename: 'a.xlsx',
      }),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'damaged' },
    });
    expect(
      await represent(workbook({ Plan: '' }), {
        format: 'xlsx',
        filename: 'a.xlsx',
      }),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'empty' },
    });
  });
});

describe('PDF', () => {
  it('reads the text layer per page', async () => {
    expect(
      await represent(
        textPdf([
          'Auftragsbestätigung',
          'Ihre Bestellung: PO-1001',
          '6 x SKU-1',
        ]),
        { format: 'pdf', filename: 'ab.pdf' },
      ),
    ).toEqual({
      ok: true,
      representation: {
        kind: 'text',
        pages: ['Auftragsbestätigung\nIhre Bestellung: PO-1001\n6 x SKU-1'],
      },
      truncated: false,
    });
  });

  it('reports scans, damage and passwords as unreadable', async () => {
    expect(
      await represent(textPdf([]), { format: 'pdf', filename: 'scan.pdf' }),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'no_text' },
    });
    expect(
      await represent(new Uint8Array(Buffer.from('not a pdf')), {
        format: 'pdf',
        filename: 'x.pdf',
      }),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'damaged' },
    });
    // A standard security handler whose user password is not empty.
    const id = '<0123456789abcdef0123456789abcdef>';
    const key = (byte: string) => `<${byte.repeat(32)}>`;
    expect(
      await represent(
        textPdf(
          ['secret'],
          `/Encrypt << /Filter /Standard /V 1 /R 2 /O ${key('ab')} /U ${key('cd')} /P -4 >> /ID [${id} ${id}] `,
        ),
        { format: 'pdf', filename: 'locked.pdf' },
      ),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'encrypted' },
    });
  });
});

describe('plain text', () => {
  it('reads one page and rejects binary content', async () => {
    expect(
      await represent(new Uint8Array(Buffer.from('PO-1001\r\nok')), {
        format: 'txt',
        filename: 'a.txt',
      }),
    ).toEqual({
      ok: true,
      representation: { kind: 'text', pages: ['PO-1001\nok'] },
      truncated: false,
    });
    expect(
      await represent(
        new Uint8Array(Array.from({ length: 100 }, (_, i) => i % 8)),
        {
          format: 'txt',
          filename: 'a.txt',
        },
      ),
    ).toEqual({
      ok: false,
      outcome: { state: 'unreadable', failure: 'damaged' },
    });
  });
});
