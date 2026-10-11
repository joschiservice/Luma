const winAnsi: Record<string, string> = {
  '€': '\x80',
  '–': '\x96',
  '’': '\x92',
};

/** Escapes a PDF string literal in WinAnsi encoding; other characters become `?`. */
const pdfText = (value: string) =>
  [...value]
    .map((char) => winAnsi[char] ?? (char.charCodeAt(0) <= 0xff ? char : '?'))
    .join('')
    .replace(/[()\\]/g, '\\$&');

/**
 * Builds a one-page PDF with a text layer, as standard base64. The bytes depend only on the
 * lines, so generated documents stay deterministic. At most 50 lines fit on the page.
 */
export function textPdf(lines: string[]) {
  const stream = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '56 786 Td',
    ...lines.slice(0, 50).map((line) => `(${pdfText(line)}) Tj T*`),
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
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1').toString('base64');
}

/** Builds a semicolon-separated CSV, as German spreadsheet exports use, as standard base64. */
export function csv(rows: (string | number)[][]) {
  const cell = (value: string | number) => {
    const text = String(value);

    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return Buffer.from(
    `${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`,
    'utf8',
  ).toString('base64');
}
