/** Rows one export may contain; larger lists are cut off and the file says so. */
export const exportRowLimit = 5000;

// Spreadsheets run cell text that starts with these characters as a formula.
const formulaStart = /^[=+\-@\t\r]/;

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string')
    return formulaStart.test(value) ? `'${value}` : value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    if (
      'amount' in value &&
      'currency' in value &&
      typeof value.amount === 'string' &&
      typeof value.currency === 'string'
    )
      return `${value.amount} ${value.currency}`;
    const named = Object.entries(value).find(
      ([key, entry]) =>
        ['label', 'name', 'title', 'displayNumber'].includes(key) &&
        typeof entry === 'string',
    );
    if (named) return text(named[1]);
  }

  return text(JSON.stringify(value));
}

function quoted(cell: string) {
  return /[",\r\n;]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Writes rows as CSV with a header. Values the source did not report are empty cells; amounts
 * keep their currency; lists join with semicolons. Text that a spreadsheet would run as a
 * formula is prefixed with an apostrophe.
 */
export function exportCsv(
  columns: readonly { id: string; label: string }[],
  rows: readonly Record<string, unknown>[],
  note?: string,
): string {
  const lines = [
    columns.map((column) => quoted(text(column.label))).join(','),
    ...rows.map((row) =>
      columns.map((column) => quoted(text(row[column.id]))).join(','),
    ),
    ...(note ? [quoted(text(note))] : []),
  ];

  return `${lines.join('\r\n')}\r\n`;
}
