import { unzipSync } from 'fflate';

import { representationLimits } from '../../domain/documents.js';

/** Raised for workbooks Luma cannot open; the reason is a controlled code. */
export class WorkbookError extends Error {
  constructor(readonly reason: 'encrypted' | 'damaged' | 'too_large') {
    super(`Workbook ${reason}`);
  }
}

/** Uncompressed bytes read from one workbook; guards against archives that expand enormously. */
const maxExpandedBytes = 150 * 1024 * 1024;

const entities: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Decodes XML entities and the `_xHHHH_` escapes spreadsheet strings use for control characters. */
function decode(value: string) {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);

        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }

      return entities[entity] ?? whole;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

interface Tag {
  name: string;
  attributes: Record<string, string>;
  close: boolean;
  selfClosing: boolean;
}

type Token = Tag | { text: string };

/** Splits XML into tags (namespace prefixes removed) and text; enough for workbook parts. */
function* tokens(xml: string): Generator<Token> {
  const pattern =
    /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[6] !== undefined) yield { text: decode(match[6]) };
    else if (match[5] !== undefined) yield { text: match[5] };
    else if (match[2]) {
      const attributes: Record<string, string> = {};
      for (const attribute of (match[3] ?? '').matchAll(
        /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      ))
        attributes[attribute[1]!.replace(/^.*:/, '')] = decode(
          attribute[2] ?? attribute[3] ?? '',
        );
      yield {
        name: match[2].replace(/^.*:/, ''),
        attributes,
        close: match[1] === '/',
        selfClosing: match[4] === '/',
      };
    }
  }
}

const isTag = (token: Token): token is Tag => 'name' in token;

/** Shared strings: the text of each `si`, without phonetic runs. */
function sharedStrings(xml: string | undefined) {
  const strings: string[] = [];
  if (!xml) return strings;
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const token of tokens(xml)) {
    if (!isTag(token)) {
      if (current !== null && inText && !phonetic) current += token.text;
      continue;
    }
    if (token.name === 'si' && !token.close)
      current = token.selfClosing ? null : '';
    if (token.name === 'si' && token.selfClosing) strings.push('');
    else if (token.name === 'si' && token.close) {
      strings.push(current ?? '');
      current = null;
    } else if (token.name === 'rPh' && !token.selfClosing)
      phonetic += token.close ? -1 : 1;
    else if (token.name === 't' && !token.selfClosing) inText = !token.close;
  }

  return strings;
}

/** Built-in number formats that show dates. */
const dateFormatIds = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Whether a custom format code shows a date: day, month or year tokens outside literals. */
const isDateFormat = (code: string) =>
  /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** For each cell style index, whether it formats numbers as dates. */
function dateStyles(xml: string | undefined) {
  const styles: boolean[] = [];
  if (!xml) return styles;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  for (const token of tokens(xml)) {
    if (!isTag(token)) continue;
    if (token.name === 'numFmt' && !token.close)
      custom.set(
        Number(token.attributes.numFmtId),
        token.attributes.formatCode ?? '',
      );
    if (token.name === 'cellXfs')
      inCellXfs = !token.close && !token.selfClosing;
    else if (inCellXfs && token.name === 'xf' && !token.close) {
      const id = Number(token.attributes.numFmtId ?? 0);
      styles.push(
        dateFormatIds.has(id) ||
          (custom.has(id) && isDateFormat(custom.get(id)!)),
      );
    }
  }

  return styles;
}

/** Converts a spreadsheet date serial to an ISO date, with the time when it has one. */
export function serialDate(serial: number, date1904: boolean) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  // The 1900 system counts a 29 February 1900 that never existed.
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();

  return ms % 86_400_000 === 0
    ? iso.slice(0, 10)
    : iso.slice(0, 16).replace('T', ' ');
}

/** A number as people would read it, without binary floating-point noise. */
function numberText(raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;

  return String(Number(value.toPrecision(15)));
}

/** Column index (0-based) of a cell reference such as "AB12". */
function columnIndex(reference: string) {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const letter of letters)
    index = index * 26 + (letter.charCodeAt(0) - 64);

  return index - 1;
}

function rowIndex(reference: string) {
  const digits = /(\d+)$/.exec(reference)?.[1];

  return digits ? Number(digits) - 1 : null;
}

/** Reads one worksheet into rows of strings, within the representation limits. */
function worksheet(
  xml: string,
  strings: readonly string[],
  styles: readonly boolean[],
  date1904: boolean,
) {
  const rows: string[][] = [];
  let truncated = false;
  let row = -1;
  let column = -1;
  let cell: { type: string; style: number; column: number } | null = null;
  let value = '';
  let inValue = false;
  for (const token of tokens(xml)) {
    if (!isTag(token)) {
      if (cell && inValue) value += token.text;
      continue;
    }
    if (token.name === 'row' && !token.close) {
      row = token.attributes.r ? Number(token.attributes.r) - 1 : row + 1;
      column = -1;
    } else if (token.name === 'c' && !token.close) {
      const reference = token.attributes.r;
      column = (reference ? columnIndex(reference) : null) ?? column + 1;
      if (reference) row = rowIndex(reference) ?? row;
      cell = {
        type: token.attributes.t ?? 'n',
        style: Number(token.attributes.s ?? 0),
        column,
      };
      value = '';
      if (token.selfClosing) cell = null;
    } else if ((token.name === 'v' || token.name === 't') && cell)
      inValue = !token.close && !token.selfClosing;
    else if (token.name === 'c' && token.close && cell) {
      const text =
        cell.type === 's'
          ? (strings[Number(value)] ?? '')
          : cell.type === 'b'
            ? value === '1'
              ? 'TRUE'
              : 'FALSE'
            : cell.type === 'n' && value !== ''
              ? styles[cell.style]
                ? (serialDate(Number(value), date1904) ?? numberText(value))
                : numberText(value)
              : value;
      if (text !== '') {
        if (
          row >= representationLimits.rows ||
          cell.column >= representationLimits.columns
        )
          truncated = true;
        else {
          while (rows.length <= row) rows.push([]);
          const target = rows[row]!;
          while (target.length < cell.column) target.push('');
          target[cell.column] = text.slice(0, representationLimits.cell);
          if (text.length > representationLimits.cell) truncated = true;
        }
      }
      cell = null;
      inValue = false;
    }
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push('');

  return { rows, truncated };
}

const decoder = new TextDecoder('utf-8');

/**
 * Reads an XLSX workbook into sheets of text cells. Shared and inline strings are resolved,
 * date-formatted numbers become ISO dates, and other numbers keep their value. Encrypted
 * workbooks, other archives and damaged parts raise `WorkbookError`.
 */
export function parseXlsx(bytes: Uint8Array): {
  sheets: { name: string; rows: string[][] }[];
  truncated: boolean;
} {
  // Encrypted workbooks are compound files holding an `EncryptedPackage` stream.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11) {
    const marker = Buffer.from('EncryptedPackage', 'utf16le');
    throw new WorkbookError(
      Buffer.from(bytes).includes(marker) ? 'encrypted' : 'damaged',
    );
  }
  let expanded = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const wanted =
          /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(
            file.name,
          );
        if (wanted) expanded += file.originalSize;
        if (expanded > maxExpandedBytes) throw new WorkbookError('too_large');

        return wanted;
      },
    });
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    throw new WorkbookError('damaged');
  }
  const text = (name: string) =>
    files[name] ? decoder.decode(files[name]) : undefined;
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new WorkbookError('damaged');
  const relationships = new Map<string, string>();
  for (const token of tokens(text('xl/_rels/workbook.xml.rels') ?? ''))
    if (isTag(token) && token.name === 'Relationship' && token.attributes.Id)
      relationships.set(token.attributes.Id, token.attributes.Target ?? '');
  const sheetsInfo: { name: string; target: string }[] = [];
  let date1904 = false;
  for (const token of tokens(workbook)) {
    if (!isTag(token) || token.close) continue;
    if (token.name === 'workbookPr')
      date1904 = ['1', 'true'].includes(token.attributes.date1904 ?? '');
    if (token.name === 'sheet' && token.attributes.state !== 'veryHidden') {
      const target = relationships.get(token.attributes.id ?? '');
      if (!target) continue;
      sheetsInfo.push({
        name: (token.attributes.name ?? `Sheet${sheetsInfo.length + 1}`).slice(
          0,
          200,
        ),
        target: target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, '')}`,
      });
    }
  }
  const strings = sharedStrings(text('xl/sharedStrings.xml'));
  const styles = dateStyles(text('xl/styles.xml'));
  let truncated = sheetsInfo.length > representationLimits.sheets;
  const sheets: { name: string; rows: string[][] }[] = [];
  for (const info of sheetsInfo.slice(0, representationLimits.sheets)) {
    const xml = text(info.target);
    if (xml === undefined) throw new WorkbookError('damaged');
    const sheet = worksheet(xml, strings, styles, date1904);
    truncated ||= sheet.truncated;
    sheets.push({ name: info.name, rows: sheet.rows });
  }
  if (!sheets.length) throw new WorkbookError('damaged');

  return { sheets, truncated };
}
