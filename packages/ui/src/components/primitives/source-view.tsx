import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { useEffect, useRef } from 'react';

import { cn } from '../../lib/utils';

/** A highlighted part of a source text, as character offsets into that text (end exclusive). */
export interface SourceSpan {
  id: string;
  start: number;
  end: number;
}

/** A rectangle of spreadsheet cells, 1-based and inclusive. */
export interface CellRange {
  row: number;
  rowEnd: number;
  column: number;
  columnEnd: number;
}

/** Spreadsheet column name for a 1-based index: 1 → A, 27 → AA. */
export function columnName(index: number) {
  let name = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;

  return name;
}

/**
 * Splits a text into consecutive segments at every span boundary, listing the spans that cover
 * each segment. Spans outside the text are clipped; overlapping spans share segments.
 */
export function textSegments(text: string, spans: readonly SourceSpan[]) {
  const clipped = spans
    .map((span) => ({
      ...span,
      start: Math.max(0, Math.min(span.start, text.length)),
      end: Math.max(0, Math.min(span.end, text.length)),
    }))
    .filter((span) => span.end > span.start);
  const cuts = [
    ...new Set([
      0,
      text.length,
      ...clipped.flatMap((span) => [span.start, span.end]),
    ]),
  ].sort((a, b) => a - b);

  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1]!;

    return {
      start,
      end,
      text: text.slice(start, end),
      spans: clipped
        .filter((span) => span.start <= start && span.end >= end)
        .map((span) => span.id),
    };
  });
}

/**
 * Returns the reader's text selection as offsets into the text rendered by `SourceText`, or null
 * when nothing inside `container` is selected.
 */
export function selectedSpan(container: Element) {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
    return null;
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  )
    return null;
  const before = container.ownerDocument.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const text = range.toString();

  return { start, end: start + text.length, text };
}

function useScrollToSelected(selected: string | undefined) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const target = root.current?.querySelector('[data-selected]');
    if (!target) return;
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    target.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [selected]);

  return root;
}

/**
 * Shows a source text with its line breaks and highlights cited spans. The `selected` span is
 * emphasized and scrolled into view. Clicking a highlight selects it; keyboard users select from
 * the list that owns the spans, so highlights are not tab stops. Text stays selectable, so callers
 * can read a new span with `selectedSpan`.
 */
export function SourceText({
  text,
  spans = [],
  selected,
  onSelect,
  label,
  className,
}: {
  text: string;
  spans?: readonly SourceSpan[];
  selected?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  /** Names the text region, such as "Page 2". */
  label: string;
  className?: string | undefined;
}) {
  const root = useScrollToSelected(selected);

  return (
    <div
      ref={root}
      role="region"
      aria-label={label}
      className={cn('lu-source-text', className)}
      data-source-text=""
    >
      {textSegments(text, spans).map((segment) =>
        segment.spans.length ? (
          <mark
            key={segment.start}
            data-selected={
              selected && segment.spans.includes(selected) ? '' : undefined
            }
            onClick={() => {
              const next =
                segment.spans.find((id) => id !== selected) ??
                segment.spans[0]!;
              onSelect?.(next);
            }}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

const inRange = (range: CellRange, row: number, column: number) =>
  row >= range.row &&
  row <= range.rowEnd &&
  column >= range.column &&
  column <= range.columnEnd;

/**
 * Shows one spreadsheet sheet as a grid with row numbers and column letters. Cited ranges are
 * highlighted and the `selected` one is emphasized and scrolled into view. With
 * `onPick`, clicking a cell picks it and Shift-click extends the pick to a range; `picked` is
 * shown outlined. Large sheets show their first `maxRows` rows with a note.
 */
export function SourceSheet({
  name,
  rows,
  ranges = [],
  selected,
  onSelect,
  picked,
  onPick,
  maxRows = 1000,
}: {
  name: string;
  rows: readonly (readonly string[])[];
  ranges?: readonly (CellRange & { id: string })[];
  selected?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  picked?: CellRange | null | undefined;
  onPick?: ((range: CellRange) => void) | undefined;
  maxRows?: number;
}) {
  const root = useScrollToSelected(selected);
  const shown = rows.slice(0, maxRows);
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const anchor = useRef<{ row: number; column: number } | null>(null);

  const pick = (row: number, column: number, extend: boolean) => {
    const covering = ranges.filter((range) => inRange(range, row, column));
    if (covering.length && onSelect)
      onSelect(
        (covering.find((range) => range.id !== selected) ?? covering[0]!).id,
      );
    if (!onPick) return;
    const from = extend && anchor.current ? anchor.current : { row, column };
    if (!extend) anchor.current = { row, column };
    onPick({
      row: Math.min(from.row, row),
      rowEnd: Math.max(from.row, row),
      column: Math.min(from.column, column),
      columnEnd: Math.max(from.column, column),
    });
  };

  return (
    <div
      ref={root}
      role="region"
      aria-label={name}
      tabIndex={0}
      className="lu-source-sheet"
    >
      <table>
        <caption className="sr-only">{name}</caption>
        <thead>
          <tr>
            <td aria-hidden="true" />
            {Array.from({ length: columns }, (_, index) => (
              <th key={index} scope="col">
                {columnName(index + 1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((cells, rowIndex) => {
            const row = rowIndex + 1;

            return (
              <tr key={row}>
                <th scope="row">{formatNumber(row)}</th>
                {Array.from({ length: columns }, (_, columnIndex) => {
                  const column = columnIndex + 1;
                  const covering = ranges.filter((range) =>
                    inRange(range, row, column),
                  );

                  return (
                    <td
                      key={column}
                      data-marked={covering.length ? '' : undefined}
                      data-selected={
                        covering.some((range) => range.id === selected)
                          ? ''
                          : undefined
                      }
                      data-picked={
                        picked && inRange(picked, row, column) ? '' : undefined
                      }
                      onClick={(event) => pick(row, column, event.shiftKey)}
                    >
                      {cells[columnIndex] ?? ''}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <p className="lu-source-note">
          {m.ui_source_rows_limited({
            shown: formatNumber(shown.length),
            total: formatNumber(rows.length),
          })}
        </p>
      ) : null}
    </div>
  );
}
