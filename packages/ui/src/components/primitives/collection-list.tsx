import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { m } from '@luma/i18n/messages';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { useRowSelection } from '../../lib/row-selection';
import { cn } from '../../lib/utils';
import { Checkbox } from './checkbox';
import { SelectionAnnouncement } from './live-region';

export type CollectionListDensity = 'comfortable' | 'compact';

/** Row selection through a checkbox per row; the caller owns the selected row keys. */
interface CollectionListSelection<Item> {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Names a row for its checkbox, such as the order number. */
  rowLabel: (item: Item) => string;
}

export interface CollectionListProps<Item> {
  /** Names the list for assistive technology, such as "Issues". */
  label: string;
  items: readonly Item[];
  itemKey: (item: Item) => string;
  /**
   * The row's link, such as a router `<Link>` without children. The list renders the row's
   * content into it, marks it as the keyboard focus target and sets `aria-current` for the open
   * record. An `id` on the link lets the page return focus to the row.
   */
  link: (item: Item) => ReactElement;
  title: (item: Item) => ReactNode;
  /** A second line under the title, such as a message snippet. Hidden in compact density. */
  description?: ((item: Item) => ReactNode) | undefined;
  /** An icon before the title. */
  leading?: ((item: Item) => ReactNode) | undefined;
  /**
   * Labels every row shows whatever the Display settings, such as what the record waits for, so
   * attention never depends on a hidden property.
   */
  status?: ((item: Item) => ReactNode) | undefined;
  /**
   * Property keys in display order, as chosen in the Display menu. Each one is a column that
   * lines up across rows; pages may render short properties in `description` instead.
   */
  properties?: readonly string[] | undefined;
  /** Renders one property of a row; null or false leaves its cell empty in that row. */
  property?: ((item: Item, key: string) => ReactNode) | undefined;
  density?: CollectionListDensity | undefined;
  /** `framed` draws the shared list border; `plain` sits in a pane that already has one. */
  variant?: 'framed' | 'plain' | undefined;
  /** The key of the record open next to the list. */
  current?: string | undefined;
  /** The key of the row `useListKeyboard` acts on. */
  focusedKey?: string | undefined;
  selection?: CollectionListSelection<Item> | undefined;
  /** Shown instead of the rows while the first read runs. */
  loading?: ReactNode;
  /** Shown when there are no rows. Describe this view, not the whole business. */
  empty?: ReactNode;
  className?: string | undefined;
}

/**
 * A record list: one row per record with a title, optional description and the properties the
 * reader chose in the Display menu, in comfortable or compact density. Status and properties line
 * up in columns across rows; narrow lists put them under the title. Rows are list items with one
 * link each, so they keep list and link semantics instead of an ARIA grid; `useListKeyboard`
 * moves between them. Selection adds a labelled checkbox before the link, with shift-click ranges,
 * and announces the count. The list renders what the caller passes and never sorts or filters.
 */
export function CollectionList<Item>({
  label,
  items,
  itemKey,
  link,
  title,
  description,
  leading,
  status,
  properties = [],
  property,
  density = 'comfortable',
  variant = 'framed',
  current,
  focusedKey,
  selection,
  loading,
  empty,
  className,
}: CollectionListProps<Item>) {
  const keys = items.map(itemKey);
  const select = useRowSelection({
    keys,
    selected: selection?.selected ?? [],
    onChange: (next) => selection?.onChange(next),
  });

  if (loading) return <>{loading}</>;
  if (!items.length) return <>{empty}</>;
  // The title takes the remaining width; long properties truncate at their own maximum.
  const columns = [
    selection ? 'auto' : null,
    leading ? 'auto' : null,
    'minmax(min(10rem, 100%), 1fr)',
    status ? 'auto' : null,
    ...properties.map(() => 'auto'),
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <ul
        aria-label={label}
        data-slot="collection-list"
        data-density={density}
        data-variant={variant}
        className={cn('ui-collection-list', className)}
        style={{ '--collection-list-columns': columns } as CSSProperties}
      >
        {items.map((item, index) => {
          const key = keys[index] ?? '';
          const isCurrent = key === current;
          const selected = select.isSelected(key);
          const icon = leading?.(item);
          const detail = density === 'compact' ? null : description?.(item);

          return (
            <li
              key={key}
              data-list-row=""
              data-focused={key === focusedKey ? '' : undefined}
              data-current={isCurrent ? '' : undefined}
              data-selected={selected ? '' : undefined}
              className="ui-collection-list-row"
            >
              {selection ? (
                <label className="ui-collection-list-select">
                  <Checkbox
                    aria-label={m.ui_table_select_row({
                      row: selection.rowLabel(item),
                    })}
                    checked={selected}
                    // The change comes from a click, which carries Shift for a range.
                    onChange={(event) =>
                      select.toggle(
                        index,
                        event.nativeEvent instanceof MouseEvent &&
                          event.nativeEvent.shiftKey,
                      )
                    }
                  />
                </label>
              ) : null}
              <RowLink
                render={link(item)}
                aria-current={isCurrent ? 'page' : undefined}
              >
                {leading ? (
                  <span className="ui-collection-list-leading">{icon}</span>
                ) : null}
                <span className="ui-collection-list-main">
                  <span className="ui-collection-list-title">
                    {title(item)}
                  </span>
                  {detail ? (
                    <span className="ui-collection-list-description">
                      {detail}
                    </span>
                  ) : null}
                </span>
                {status || properties.length ? (
                  <span className="ui-collection-list-aside">
                    {status ? (
                      <span className="ui-collection-list-status">
                        {status(item)}
                      </span>
                    ) : null}
                    {properties.map((name) => {
                      const value = property?.(item, name);

                      return (
                        <span
                          key={name}
                          className="ui-collection-list-property"
                          data-property={name}
                        >
                          {value === false ? null : value}
                        </span>
                      );
                    })}
                  </span>
                ) : null}
              </RowLink>
            </li>
          );
        })}
      </ul>
      {selection ? (
        <SelectionAnnouncement count={selection.selected.length} />
      ) : null}
    </>
  );
}

const rowLinkProps = {
  className: 'ui-collection-list-link',
  'data-row-focus': '',
};

function RowLink({ render, ...props }: useRender.ComponentProps<'a'>) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(rowLinkProps, props),
  });
}
