/**
 * Deterministic reading of spreadsheet tables: a header row names the columns (English or
 * German), and each row below becomes a line with the cells it came from. Labels beside values
 * above the table, such as "Bestellnummer | PO-1001", become references and dates.
 */

import type { FactLocator, FactValue, ProposedFact } from './facts.js';
import { quoteAt, validDate, validValue } from './facts.js';

type Column =
  | 'sku'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice'
  | 'currency'
  | 'deliveryDate'
  | 'purchaseOrder'
  | 'orderNumber';

/** Normalizes a header cell: lower case, umlauts folded, punctuation removed. */
const fold = (value: string) =>
  value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const synonyms: Record<Column, string[]> = {
  sku: [
    'sku',
    'item number',
    'item no',
    'article number',
    'article no',
    'part number',
    'part no',
    'product code',
    'artikelnummer',
    'artikel nr',
    'art nr',
    'artnr',
    'materialnummer',
    'ean',
  ],
  description: [
    'description',
    'item',
    'product',
    'product name',
    'name',
    'bezeichnung',
    'artikelbezeichnung',
    'beschreibung',
    'artikel',
    'produkt',
  ],
  quantity: [
    'quantity',
    'qty',
    'confirmed quantity',
    'confirmed qty',
    'menge',
    'anzahl',
    'liefermenge',
    'bestaetigte menge',
    'stueck',
  ],
  unit: ['unit', 'uom', 'einheit', 'me', 'mengeneinheit'],
  unitPrice: [
    'unit price',
    'price',
    'net price',
    'price per unit',
    'preis',
    'einzelpreis',
    'stueckpreis',
    'nettopreis',
    'ep',
  ],
  currency: ['currency', 'waehrung', 'cur'],
  deliveryDate: [
    'delivery date',
    'ship date',
    'delivery',
    'eta',
    'liefertermin',
    'lieferdatum',
    'versanddatum',
    'termin',
  ],
  purchaseOrder: [
    'po',
    'po number',
    'purchase order',
    'purchase order number',
    'your order',
    'bestellung',
    'bestellnummer',
    'bestell nr',
    'ihre bestellung',
  ],
  orderNumber: [
    'order',
    'order number',
    'order no',
    'sales order',
    'auftrag',
    'auftragsnummer',
    'auftrags nr',
  ],
};

const lookup = new Map<string, Column>(
  Object.entries(synonyms).flatMap(([column, names]) =>
    names.map((name) => [name, column as Column] as const),
  ),
);

/** The column a header cell names, or null. */
function headerColumn(cell: string): Column | null {
  const folded = fold(cell);

  return folded ? (lookup.get(folded) ?? null) : null;
}

const currencySymbols: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  CHF: 'CHF',
};

/**
 * Parses a decimal written in English or German style ("1,234.50", "1.234,50", "12,5").
 * `ambiguous` is set for a lone grouping such as "1,500", which could be either.
 */
export function parseDecimal(
  input: string,
): { value: string; ambiguous: boolean } | null {
  const raw = input.replace(/[\s\u00a0']/g, '');
  if (!/^-?[\d.,]+$/.test(raw) || !/\d/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  let normalized: string;
  let ambiguous = false;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    normalized = digits.split(group).join('').replace(decimal, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? ',' : '.';
    const parts = digits.split(separator);
    if (parts.length > 2) normalized = parts.join('');
    else if (/^\d{1,3}$/.test(parts[0]!) && /^\d{3}$/.test(parts[1]!)) {
      // "1,500" or "1.500": a thousands group in one style, a decimal in the other.
      ambiguous = true;
      normalized = parts.join(separator === ',' ? '.' : '');
    } else normalized = parts.join('.');
  } else normalized = digits;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (whole!.replace(/^0+(?=\d)/, '').length > 14 || trimmed.length > 6)
    return null;
  const value = `${negative ? '-' : ''}${whole!.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;

  return { value, ambiguous };
}

/** Reads an amount with an optional currency symbol or code, such as "12,50 €" or "EUR 3.10". */
export function parseMoney(
  input: string,
  fallbackCurrency: string | null,
): { amount: string; currency: string | null; ambiguous: boolean } | null {
  let currency: string | null = null;
  let rest = input.trim();
  for (const [symbol, code] of Object.entries(currencySymbols))
    if (rest.includes(symbol)) {
      currency = code;
      rest = rest.replace(symbol, '');
    }
  const code = /\b([A-Z]{3})\b/.exec(rest);
  if (code) {
    currency = code[1]!;
    rest = rest.replace(code[0], '');
  }
  const amount = parseDecimal(rest);
  if (!amount) return null;

  return {
    amount: amount.value,
    currency: currency ?? fallbackCurrency,
    ambiguous: amount.ambiguous,
  };
}

/**
 * Reads a calendar date: ISO, German "20.10.2026" or "20.10.26", or "20/10/2026". Slashes are
 * read day first; when both parts could be the month, the date is `ambiguous`.
 */
export function parseDate(
  input: string,
): { date: string; ambiguous: boolean } | null {
  const value = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(value);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;

    return validDate(date) ? { date, ambiguous: false } : null;
  }
  const dotted = /^(\d{1,2})([./])(\d{1,2})\2(\d{2}|\d{4})$/.exec(value);
  if (!dotted) return null;
  const year = dotted[4]!.length === 2 ? `20${dotted[4]}` : dotted[4]!;
  const day = dotted[1]!.padStart(2, '0');
  const month = dotted[3]!.padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  if (!validDate(date)) return null;

  return {
    date,
    ambiguous:
      dotted[2] === '/' && Number(dotted[1]) <= 12 && dotted[1] !== dotted[3],
  };
}

/** Splits "10 Stk" into a quantity and a unit. */
function quantityAndUnit(cell: string) {
  const match = /^\s*([\d.,\s]+?)\s*([A-Za-zÄÖÜäöü.]{1,20})?\s*$/.exec(cell);
  if (!match) return null;
  const quantity = parseDecimal(match[1]!);
  if (!quantity || quantity.value.startsWith('-')) return null;

  return {
    quantity: quantity.value,
    ambiguous: quantity.ambiguous,
    unit: match[2]?.replace(/\.$/, '') || null,
  };
}

interface Sheet {
  name: string;
  rows: string[][];
}

/** Rows searched for a header; documents put a letterhead above their table. */
const headerSearchRows = 30;

/** Finds the header row: the first row naming at least two columns, one of them a line column. */
function findHeader(rows: readonly string[][]) {
  for (const [index, row] of rows.slice(0, headerSearchRows).entries()) {
    const columns = new Map<Column, number>();
    for (const [column, cell] of row.entries()) {
      const name = headerColumn(cell);
      if (name && !columns.has(name)) columns.set(name, column);
    }
    if (
      columns.size >= 2 &&
      (columns.has('sku') ||
        columns.has('description') ||
        columns.has('quantity'))
    )
      return { index, columns };
  }

  return null;
}

/** The single-cell or row-span locator for cells in one row. */
function cells(
  sheet: string,
  row: number,
  columns: number[],
): Extract<FactLocator, { kind: 'cells' }> {
  return {
    kind: 'cells',
    sheet,
    row: row + 1,
    rowEnd: row + 1,
    column: Math.min(...columns) + 1,
    columnEnd: Math.max(...columns) + 1,
  };
}

/** The cited cells' text, exactly as a reviewer's locator check reads it. */
const quoteOf = (sheet: Sheet, locator: FactLocator) =>
  quoteAt({ kind: 'sheets', sheets: [sheet] }, locator) ?? '';

/** A reference or date written as a label with its value in the next cell or after a colon. */
function labelled(sheet: Sheet, until: number): ProposedFact[] {
  const facts: ProposedFact[] = [];
  for (const [rowIndex, row] of sheet.rows.slice(0, until).entries())
    for (const [column, cell] of row.entries()) {
      const colon = /^([^:]{2,40}):\s*(.+)$/.exec(cell.trim());
      const label = colon ? colon[1]! : cell;
      const name = headerColumn(label);
      if (
        name !== 'purchaseOrder' &&
        name !== 'orderNumber' &&
        name !== 'deliveryDate'
      )
        continue;
      const valueColumn = colon
        ? column
        : row.findIndex((next, index) => index > column && next.trim() !== '');
      if (valueColumn < 0) continue;
      const text = colon ? colon[2]!.trim() : row[valueColumn]!.trim();
      const locator = cells(sheet.name, rowIndex, [column, valueColumn]);
      const quote = quoteOf(sheet, locator);
      if (name === 'deliveryDate') {
        const date = parseDate(text);
        if (date)
          facts.push({
            value: { kind: 'date', role: 'delivery', date: date.date },
            locator,
            quote,
            confidence: date.ambiguous ? 'low' : 'high',
            origin: 'table',
          });
        continue;
      }
      const value: FactValue = {
        kind: 'reference',
        role: name === 'purchaseOrder' ? 'purchase_order' : 'order',
        text: text.slice(0, 200),
      };
      if (validValue(value))
        facts.push({
          value,
          locator,
          quote,
          confidence: 'high',
          origin: 'table',
        });
    }

  return facts;
}

/**
 * Reads lines, delivery dates and references from spreadsheet tables. Every fact cites the
 * cells it came from; numbers or dates that could be read two ways are low confidence.
 */
export function tableFacts(sheets: readonly Sheet[]): ProposedFact[] {
  const facts: ProposedFact[] = [];
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows);
    const above = labelled(
      sheet,
      header?.index ?? Math.min(sheet.rows.length, headerSearchRows),
    );
    facts.push(...above);
    if (!header) continue;
    const at = (row: string[], column: Column) => {
      const index = header.columns.get(column);

      return index === undefined ? '' : (row[index] ?? '').trim();
    };
    const sheetCurrency =
      sheet.rows
        .slice(header.index + 1)
        .map((row) => at(row, 'currency').toUpperCase())
        .find((code) => /^[A-Z]{3}$/.test(code)) ?? null;
    // A reference named above the table is not repeated for each row that names it again.
    const named = new Set(
      above.flatMap((fact) =>
        fact.value.kind === 'reference'
          ? [`${fact.value.role}:${fact.value.text}`]
          : [],
      ),
    );
    const references = new Map<string, ProposedFact>();
    for (
      let rowIndex = header.index + 1;
      rowIndex < sheet.rows.length;
      rowIndex++
    ) {
      const row = sheet.rows[rowIndex]!;
      if (row.every((cell) => !cell.trim())) continue;
      const sku = at(row, 'sku');
      const description = at(row, 'description');
      const quantityCell = at(row, 'quantity');
      const parsed = quantityCell ? quantityAndUnit(quantityCell) : null;
      let low = !!quantityCell && !parsed;
      if ((sku || description) && (parsed || !quantityCell)) {
        const priceCell = at(row, 'unitPrice');
        const currencyCell = at(row, 'currency').toUpperCase();
        const price = priceCell
          ? parseMoney(
              priceCell,
              /^[A-Z]{3}$/.test(currencyCell) ? currencyCell : sheetCurrency,
            )
          : null;
        low ||= !!parsed?.ambiguous || !!price?.ambiguous;
        // A price without a currency is not a price Luma can compare.
        if (priceCell && (!price || !price.currency)) low = true;
        const value: FactValue = {
          kind: 'line',
          sku: sku ? sku.slice(0, 200) : null,
          description: description ? description.slice(0, 500) : null,
          quantity: parsed?.quantity ?? null,
          unit: (at(row, 'unit') || parsed?.unit || null)?.slice(0, 40) ?? null,
          unitPrice:
            price?.currency && /^[A-Z]{3}$/.test(price.currency)
              ? { amount: price.amount, currency: price.currency }
              : null,
        };
        const lineColumns = (
          [
            'sku',
            'description',
            'quantity',
            'unit',
            'unitPrice',
            'currency',
          ] as Column[]
        )
          .map((column) => header.columns.get(column))
          .filter(
            (column): column is number =>
              column !== undefined && (row[column] ?? '').trim() !== '',
          );
        if (validValue(value) && lineColumns.length) {
          const locator = cells(sheet.name, rowIndex, lineColumns);
          facts.push({
            value,
            locator,
            quote: quoteOf(sheet, locator),
            confidence: low ? 'low' : 'high',
            origin: 'table',
          });
        }
      }
      const dateCell = at(row, 'deliveryDate');
      const date = dateCell ? parseDate(dateCell) : null;
      if (date) {
        const locator = cells(sheet.name, rowIndex, [
          header.columns.get('deliveryDate')!,
        ]);
        facts.push({
          value: { kind: 'date', role: 'delivery', date: date.date },
          locator,
          quote: quoteOf(sheet, locator),
          confidence: date.ambiguous ? 'low' : 'high',
          origin: 'table',
        });
      }
      for (const [column, role] of [
        ['purchaseOrder', 'purchase_order'],
        ['orderNumber', 'order'],
      ] as const) {
        const text = at(row, column);
        if (
          !text ||
          named.has(`${role}:${text}`) ||
          references.has(`${role}:${text}`)
        )
          continue;
        const locator = cells(sheet.name, rowIndex, [
          header.columns.get(column)!,
        ]);
        references.set(`${role}:${text}`, {
          value: { kind: 'reference', role, text: text.slice(0, 200) },
          locator,
          quote: quoteOf(sheet, locator),
          confidence: 'high',
          origin: 'table',
        });
      }
    }
    facts.push(...references.values());
  }

  return facts;
}
