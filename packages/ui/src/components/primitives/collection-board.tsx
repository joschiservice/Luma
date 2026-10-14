import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { m } from '@luma/i18n/messages';
import { MoveRight } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from 'react';

import { cn } from '../../lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './dropdown-menu';

/** One board column: a group of the list, in the order the list returned it. */
export interface CollectionBoardColumn<Item> {
  key: string;
  label: string;
  /** Every record in the group, not only the cards shown. */
  count: number;
  /** False when the count may be missing records. */
  complete?: boolean | undefined;
  /** Totals shown under the column name, such as amounts per currency. */
  summary?: ReactNode;
  items: readonly Item[];
  /** Loads more of the column's records; omitted when every record is shown. */
  more?:
    | { onClick: () => void; pending?: boolean | undefined; label?: string }
    | undefined;
}

export interface CollectionBoardProps<Item> {
  /** Names the board, such as "Orders by status". */
  label: string;
  columns: readonly CollectionBoardColumn<Item>[];
  itemKey: (item: Item) => string;
  /** The card's link, such as a router `<Link>` without children. */
  link: (item: Item) => ReactElement;
  title: (item: Item) => ReactNode;
  /** Labels every card shows, such as what needs attention. */
  status?: ((item: Item) => ReactNode) | undefined;
  /** Property keys in display order, as chosen in the Display menu. */
  properties?: readonly string[] | undefined;
  property?: ((item: Item, key: string) => ReactNode) | undefined;
  /** The key of the card `useListKeyboard` acts on. */
  focusedKey?: string | undefined;
  /** The key of the record open next to the board. */
  current?: string | undefined;
  /**
   * Moves a record to another column. Only pages whose grouping field Luma may change pass it,
   * through the same governed path as any other edit; without it the board is read-only and
   * offers no move affordance.
   */
  onMove?: ((item: Item, column: string) => void) | undefined;
  /** Shown when there are no columns. */
  empty?: ReactNode;
  className?: string | undefined;
}

const cardLinkProps = { className: 'ui-board-card-link', 'data-row-focus': '' };

function CardLink({ render, ...props }: useRender.ComponentProps<'a'>) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(cardLinkProps, props),
  });
}

/** Focuses the card link at `row` in column `column`, clamped to the column's cards. */
function focusCard(board: HTMLElement, column: number, row: number) {
  const columns = board.querySelectorAll<HTMLElement>('[data-board-column]');
  const cards =
    columns[column]?.querySelectorAll<HTMLElement>('[data-row-focus]') ?? [];
  const card = cards[Math.min(row, cards.length - 1)];
  if (!card) return false;
  card.focus();
  card.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  return true;
}

/**
 * Shows grouped records as columns of cards, one column per group in the list's group order,
 * each with its name, count, an incomplete marker, an optional summary and "Show more". The
 * board scrolls sideways. Cards are list items with one link, marked as list rows so
 * `useListKeyboard` moves through them (J and K run down each column in turn); the arrow keys
 * move within a column and between columns. The board is read-only unless `onMove` is passed:
 * then each card offers "Move to…", also opened with M.
 */
export function CollectionBoard<Item>({
  label,
  columns,
  itemKey,
  link,
  title,
  status,
  properties = [],
  property,
  focusedKey,
  current,
  onMove,
  empty,
  className,
}: CollectionBoardProps<Item>) {
  const id = useId();
  const [moving, setMoving] = useState<string | null>(null);

  if (!columns.length) return <>{empty}</>;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('[data-row-focus]'))
      return;
    const column = target.closest('[data-board-column]');
    const all = [
      ...event.currentTarget.querySelectorAll('[data-board-column]'),
    ];
    const columnIndex = column ? all.indexOf(column) : -1;
    const cards = [...(column?.querySelectorAll('[data-row-focus]') ?? [])];
    const row = cards.indexOf(target);
    if (columnIndex < 0 || row < 0) return;
    if (event.key === 'm' && onMove) {
      const key =
        target.closest<HTMLElement>('[data-card-key]')?.dataset.cardKey;
      if (key) {
        event.preventDefault();
        setMoving(key);
      }

      return;
    }
    const board = event.currentTarget;
    const handled =
      event.key === 'ArrowDown'
        ? row < cards.length - 1 && focusCard(board, columnIndex, row + 1)
        : event.key === 'ArrowUp'
          ? row > 0 && focusCard(board, columnIndex, row - 1)
          : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
            ? (() => {
                const step = event.key === 'ArrowRight' ? 1 : -1;
                // Skip columns without cards, such as empty or collapsed groups.
                for (
                  let next = columnIndex + step;
                  next >= 0 && next < all.length;
                  next += step
                )
                  if (focusCard(board, next, row)) return true;

                return false;
              })()
            : null;
    // The board owns the arrow keys, even at an edge, so the list keys don't move past it.
    if (handled !== null) event.preventDefault();
  };

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="collection-board"
      className={cn('ui-collection-board', className)}
      onKeyDown={onKeyDown}
    >
      {columns.map((column, index) => {
        const heading = `${id}-${index}`;

        return (
          <section
            key={column.key}
            className="ui-board-column"
            data-board-column=""
            aria-labelledby={heading}
          >
            <header className="ui-board-column-header">
              <h2 id={heading} className="ui-board-column-title">
                <span>{column.label}</span>
                <span className="ui-board-column-count">
                  {m.ui_group_count({ count: column.count })}
                </span>
              </h2>
              {column.complete === false ? (
                <Badge tone="warning">{m.ui_group_incomplete()}</Badge>
              ) : null}
              {column.summary ? (
                <div className="ui-board-column-summary">{column.summary}</div>
              ) : null}
            </header>
            {column.items.length ? (
              <ul className="ui-board-cards">
                {column.items.map((item) => {
                  const key = itemKey(item);

                  return (
                    <li
                      key={key}
                      className="ui-board-card"
                      data-list-row=""
                      data-card-key={key}
                      data-focused={key === focusedKey ? '' : undefined}
                      data-current={key === current ? '' : undefined}
                    >
                      <CardLink
                        render={link(item)}
                        aria-current={key === current ? 'page' : undefined}
                      >
                        <span className="ui-board-card-title">
                          {title(item)}
                        </span>
                        {status ? (
                          <span className="ui-board-card-status">
                            {status(item)}
                          </span>
                        ) : null}
                        {properties.length ? (
                          <span className="ui-board-card-properties">
                            {properties.map((name) => {
                              const value = property?.(item, name);

                              return value === null ||
                                value === undefined ||
                                value === false ? null : (
                                <span
                                  key={name}
                                  className="ui-board-card-property"
                                  data-property={name}
                                >
                                  {value}
                                </span>
                              );
                            })}
                          </span>
                        ) : null}
                      </CardLink>
                      {onMove ? (
                        <DropdownMenu
                          open={moving === key}
                          onOpenChange={(open) => setMoving(open ? key : null)}
                        >
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="ui-board-card-move"
                                aria-label={m.ui_board_move()}
                                title={m.ui_board_move()}
                              >
                                <MoveRight aria-hidden="true" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>
                                {m.ui_board_move_to()}
                              </DropdownMenuLabel>
                              {columns
                                .filter((other) => other.key !== column.key)
                                .map((other) => (
                                  <DropdownMenuItem
                                    key={other.key}
                                    onClick={() => onMove(item, other.key)}
                                  >
                                    {other.label}
                                  </DropdownMenuItem>
                                ))}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="ui-board-column-empty">{m.ui_board_empty()}</p>
            )}
            {column.more ? (
              <Button
                variant="ghost"
                className="ui-board-column-more"
                disabled={column.more.pending}
                onClick={column.more.onClick}
              >
                {column.more.label ??
                  m.ui_group_show_more({ group: column.label })}
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
