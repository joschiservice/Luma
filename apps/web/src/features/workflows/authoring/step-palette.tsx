import { useDraggable } from '@dnd-kit/core';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { CircleAlert, GripVertical, Search, X } from 'lucide-react';
import { type PointerEventHandler, type Ref, useId, useState } from 'react';

import type { PaletteItem } from './draft-model';
import { paletteGroups, StepKindIcon } from './step-kinds';

/** Prefix for palette drag IDs, so drops can tell new steps from reordered ones. */
export const paletteDragPrefix = 'palette:';

function PaletteEntry({
  item,
  draggable,
  onAdd,
}: {
  item: PaletteItem;
  draggable: boolean;
  onAdd(item: PaletteItem): void;
}) {
  const describedBy = useId();
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${paletteDragPrefix}${item.key}`,
    data: { item },
    disabled: !draggable,
  });

  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        className="authoring-palette-item"
        data-kind={item.kind}
        data-dragging={isDragging}
        data-limited={!item.executable}
        aria-label={`Add step: ${item.label}`}
        aria-describedby={describedBy}
        title={
          item.executable ? undefined : `Can’t run here yet: ${item.reason}`
        }
        // Only pointer drags start here; Enter and Space add the step at the chosen place.
        onPointerDown={
          listeners?.onPointerDown as
            PointerEventHandler<HTMLButtonElement> | undefined
        }
        onClick={() => onAdd(item)}
      >
        <StepKindIcon kind={item.kind} />
        <span className="authoring-palette-text">
          <strong>{item.label}</strong>
          <span className="authoring-palette-description" id={describedBy}>
            {item.description}
            {!item.executable ? (
              <span className="sr-only">
                {' '}
                Can’t run here yet: {item.reason}
              </span>
            ) : null}
          </span>
          {!item.executable ? (
            <span className="authoring-palette-limit" aria-hidden="true">
              <CircleAlert size={12} /> Can’t run here
            </span>
          ) : null}
        </span>
        {draggable ? (
          <GripVertical
            className="authoring-palette-grip"
            aria-hidden="true"
            size={14}
          />
        ) : null}
      </button>
    </li>
  );
}

/**
 * Lists every step the workspace offers, grouped and colour-coded. Drag an entry into the
 * workflow, or select it to add it where the builder currently points.
 */
export function StepPalette({
  items,
  target,
  draggable,
  onAdd,
  onResetTarget,
  searchRef,
}: {
  items: PaletteItem[];
  /** Where a selected step will be added, in words. */
  target: string;
  draggable: boolean;
  onAdd(item: PaletteItem): void;
  onResetTarget?: (() => void) | undefined;
  searchRef?: Ref<HTMLInputElement> | undefined;
}) {
  const [query, setQuery] = useState('');
  const text = query.trim().toLowerCase();
  const shown = items.filter((item) =>
    `${item.label} ${item.description}`.toLowerCase().includes(text),
  );

  return (
    <div className="authoring-palette">
      <div className="authoring-palette-heading">
        <h2>Add steps</h2>
        <p>
          {draggable
            ? 'Drag a step into the workflow, or select one to add it '
            : 'Select a step to add it '}
          <strong>{target}</strong>.
          {onResetTarget ? (
            <Button
              variant="ghost"
              size="sm"
              className="authoring-palette-reset"
              onClick={onResetTarget}
            >
              <X aria-hidden="true" /> Reset
            </Button>
          ) : null}
        </p>
      </div>
      <div className="workflow-search">
        <Search size={16} aria-hidden="true" />
        <Input
          ref={searchRef}
          type="search"
          aria-label="Search steps"
          placeholder="Search steps…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {shown.length ? (
        paletteGroups.map(({ group, label }) => {
          const entries = shown.filter((item) => item.group === group);
          if (!entries.length) return null;

          return (
            <section key={group} aria-label={label}>
              <h3>{label}</h3>
              <ul>
                {entries.map((item) => (
                  <PaletteEntry
                    key={item.key}
                    item={item}
                    draggable={draggable}
                    onAdd={onAdd}
                  />
                ))}
              </ul>
            </section>
          );
        })
      ) : (
        <p className="authoring-hint" role="status">
          No steps match “{query}”.
        </p>
      )}
    </div>
  );
}
