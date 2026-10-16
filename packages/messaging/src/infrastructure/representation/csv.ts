import { representationLimits } from '../../domain/documents.js';
import { normalizeLines } from './text.js';

const separators = [';', ',', '\t'] as const;

/** Counts a separator per line outside quotes, for the first lines of a file. */
function counts(text: string, separator: string) {
  const result: number[] = [];
  let count = 0;
  let quoted = false;
  for (let index = 0; index < text.length && result.length < 20; index++) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) count++;
    else if (!quoted && char === '\n') {
      result.push(count);
      count = 0;
    }
  }
  if (count && result.length < 20) result.push(count);

  return result;
}

/**
 * Picks the separator that splits the most lines into the same number of columns; semicolons
 * win ties, as German exports use them with decimal commas.
 */
export function detectSeparator(text: string): string {
  let best: { separator: string; lines: number; columns: number } | null = null;
  for (const separator of separators) {
    const perLine = counts(text, separator).filter((count) => count > 0);
    if (!perLine.length) continue;
    const frequency = new Map<number, number>();
    for (const count of perLine)
      frequency.set(count, (frequency.get(count) ?? 0) + 1);
    const [columns, lines] = [...frequency.entries()].sort(
      (a, b) => b[1] - a[1] || b[0] - a[0],
    )[0]!;
    if (!best || lines > best.lines) best = { separator, lines, columns };
  }

  return best?.separator ?? ',';
}

/**
 * Parses delimited text: quoted cells may hold separators, doubled quotes and line breaks; an
 * unterminated quote runs to the end of the file. Rows and columns beyond the limits are cut
 * and reported as `truncated`.
 */
export function parseCsv(input: string): {
  rows: string[][];
  truncated: boolean;
} {
  const text = normalizeLines(input);
  const separator = detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const pushCell = () => {
    if (row.length < representationLimits.columns)
      row.push(cell.slice(0, representationLimits.cell));
    else truncated = true;
    if (cell.length > representationLimits.cell) truncated = true;
    cell = '';
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (char === separator) pushCell();
    else if (char === '\n') {
      pushCell();
      rows.push(row);
      row = [];
      if (rows.length >= representationLimits.rows) {
        truncated ||= index < text.length - 1;
        break;
      }
    } else cell += char;
  }
  if (rows.length < representationLimits.rows && (cell || row.length)) {
    pushCell();
    rows.push(row);
  }
  while (rows.length && rows.at(-1)!.every((value) => !value.trim()))
    rows.pop();

  return { rows, truncated };
}
