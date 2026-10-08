import {
  type Announcements,
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { useSmallScreen } from '@luma/ui/lib/use-small-screen';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createSteps,
  defaultInsertIndex,
  diagnosticsAt,
  duplicateStep,
  insertSteps,
  moveStep,
  type PaletteItem,
  paletteItems,
  removeStep,
  renameStep,
} from './draft-model';
import { stepKinds } from './step-kinds';
import { DragPreview, InsertSlot, StartNode, StepCard } from './step-list';
import { paletteDragPrefix, StepPalette } from './step-palette';
import { WorkflowSettings } from './workflow-settings';

/** A field an author should look at, such as a problem or an open question from generation. */
export interface BuilderFocus {
  stepIndex: number | null;
  field: string | null;
}

/** Stable identities for sortable steps; duplicate or empty IDs fall back to their position. */
function stepKeys(content: WorkflowDraftContent) {
  const counts = new Map<string, number>();
  for (const step of content.steps)
    counts.set(step.id, (counts.get(step.id) ?? 0) + 1);

  return content.steps.map((step, index) =>
    step.id && counts.get(step.id) === 1
      ? `step:${step.id}`
      : `step:${index}:${step.id}`,
  );
}

function place(index: number, content: WorkflowDraftContent) {
  if (index === 0) return m.authoring_place_start();
  if (index >= content.steps.length) return m.authoring_place_end();

  return m.authoring_place_after({ step: index });
}

/**
 * Builds a workflow as an ordered list of colour-coded steps. Authors drag steps in from the
 * palette, reorder them by handle or keyboard, and edit them in place. Every change produces new
 * draft content; the caller saves it and asks the server to validate it.
 */
export function WorkflowBuilder({
  content,
  validation,
  vocabulary,
  readOnly,
  onChange,
  focus,
  openCode,
  highlights = [],
}: {
  content: WorkflowDraftContent;
  validation: DraftValidation | undefined;
  vocabulary: AuthoringVocabulary;
  readOnly: boolean;
  onChange(next: WorkflowDraftContent): void;
  focus?: BuilderFocus | null | undefined;
  openCode(stepIndex: number): void;
  highlights?: { stepId: string | null; field: string; question: string }[];
}) {
  const small = useSmallScreen();
  const items = useMemo(() => paletteItems(vocabulary), [vocabulary]);
  const keys = stepKeys(content);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(content.steps.length <= 3 ? keys : []),
  );
  const [target, setTarget] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const [dragging, setDragging] = useState<
    | { kind: 'palette'; item: PaletteItem }
    | { kind: 'step'; index: number }
    | null
  >(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const insertAt = Math.min(
    target ?? defaultInsertIndex(content),
    content.steps.length,
  );

  useEffect(() => {
    if (focus?.stepIndex === null || focus?.stepIndex === undefined) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(`authoring-step-${focus.stepIndex}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );

    return () => cancelAnimationFrame(frame);
  }, [focus]);

  const indexOf = (id: unknown) => keys.indexOf(String(id));
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);

      return next;
    });

  function add(item: PaletteItem, index = insertAt) {
    const steps = createSteps(item.kind, content, vocabulary, item.options);
    const next = insertSteps(content, index, steps);
    onChange(next);
    setOpen(
      (current) =>
        new Set([
          ...current,
          ...stepKeys(next).slice(index, index + steps.length),
        ]),
    );
    setTarget(null);
    setSheet(false);
    requestAnimationFrame(() =>
      document
        .getElementById(`authoring-step-${index}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }

  function choose(index: number) {
    setTarget(index);
    if (small) setSheet(true);
    else search.current?.focus();
  }

  // Palette drags only land in slots or on steps; reordering only compares steps.
  const collide: CollisionDetection = (args) => {
    const palette = String(args.active.id).startsWith(paletteDragPrefix);
    const droppableContainers = args.droppableContainers.filter((item) =>
      palette
        ? String(item.id).startsWith('slot:') ||
          String(item.id).startsWith('step:')
        : String(item.id).startsWith('step:'),
    );
    if (!palette) {
      // The drag preview is much shorter than an open step, so target the step under its centre.
      const middle = args.collisionRect.top + args.collisionRect.height / 2;
      const under = droppableContainers.find((item) => {
        const rect = args.droppableRects.get(item.id);

        return rect && middle >= rect.top && middle <= rect.bottom;
      });

      return under
        ? [{ id: under.id, data: { droppableContainer: under, value: 0 } }]
        : closestCenter({ ...args, droppableContainers });
    }
    const within = pointerWithin({ ...args, droppableContainers });

    return within.length
      ? within
      : rectIntersection({ ...args, droppableContainers });
  };

  function dropTarget(event: DragOverEvent | DragEndEvent) {
    const over = event.over;
    if (!over) return null;
    const id = String(over.id);
    if (id.startsWith('slot:')) return Number(id.slice(5));
    const index = indexOf(id);
    if (index < 0) return null;
    const dragged = event.active.rect.current.translated;
    const middle = over.rect.top + over.rect.height / 2;

    return dragged && dragged.top + dragged.height / 2 > middle
      ? index + 1
      : index;
  }

  function onDragStart(event: DragStartEvent) {
    const item = event.active.data.current?.item as PaletteItem | undefined;
    setDragging(
      item
        ? { kind: 'palette', item }
        : { kind: 'step', index: indexOf(event.active.id) },
    );
  }

  function onDragOver(event: DragOverEvent) {
    if (dragging?.kind === 'palette') setDropIndex(dropTarget(event));
  }

  function onDragEnd(event: DragEndEvent) {
    const item = event.active.data.current?.item as PaletteItem | undefined;
    if (item) {
      const index = dropTarget(event);
      if (index !== null) add(item, index);
    } else if (event.over) {
      const from = indexOf(event.active.id);
      const to = indexOf(event.over.id);
      if (from >= 0 && to >= 0 && from !== to)
        onChange(moveStep(content, from, to));
    }
    setDragging(null);
    setDropIndex(null);
  }

  // Describes a dragged step by its position and type, as screen readers announce it.
  const named = (id: unknown) => {
    const index = indexOf(id);
    const step = content.steps[index];

    return {
      position: index + 1,
      kind: step
        ? stepKinds[step.kind].name()
        : m.authoring_drag_unknown_kind(),
    };
  };
  const fromPalette = (id: unknown) => String(id).startsWith(paletteDragPrefix);
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      fromPalette(active.id)
        ? m.authoring_drag_palette_start({
            step: (active.data.current?.item as PaletteItem).label,
          })
        : m.authoring_drag_step_start(named(active.id)),
    onDragOver: ({ active, over }) =>
      over && String(over.id).startsWith('step:') && !fromPalette(active.id)
        ? m.authoring_drag_step_over({
            ...named(active.id),
            target: indexOf(over.id) + 1,
            count: content.steps.length,
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      fromPalette(active.id)
        ? over
          ? m.authoring_drag_palette_added()
          : m.authoring_drag_palette_none()
        : over
          ? m.authoring_drag_step_moved({
              ...named(active.id),
              target: indexOf(over.id) + 1,
            })
          : m.authoring_drag_step_not_moved(named(active.id)),
    onDragCancel: ({ active }) =>
      fromPalette(active.id)
        ? m.authoring_drag_palette_none()
        : m.authoring_drag_step_canceled(named(active.id)),
  };
  const receiving = dragging?.kind === 'palette';
  const palette = (
    <StepPalette
      items={items}
      target={place(insertAt, content)}
      draggable={!small}
      onAdd={(item) => add(item)}
      onResetTarget={target === null ? undefined : () => setTarget(null)}
      searchRef={search}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: m.authoring_drag_instructions(),
        },
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(null);
        setDropIndex(null);
      }}
    >
      <div className="authoring-builder" data-readonly={readOnly}>
        <div className="authoring-builder-main">
          <WorkflowSettings
            content={content}
            validation={validation}
            vocabulary={vocabulary}
            readOnly={readOnly}
            onChange={onChange}
          />
          <section
            aria-labelledby="authoring-steps-title"
            className="authoring-steps-section"
          >
            <div className="authoring-section-heading">
              <div>
                <h2 id="authoring-steps-title">{m.authoring_steps_title()}</h2>
                <p>{m.authoring_steps_description()}</p>
              </div>
            </div>
            <StartNode content={content} vocabulary={vocabulary} />
            {!readOnly ? (
              <InsertSlot
                index={0}
                count={content.steps.length}
                receiving={receiving}
                active={dropIndex === 0}
                selected={target === 0}
                onSelect={choose}
              />
            ) : null}
            <SortableContext
              items={keys}
              strategy={verticalListSortingStrategy}
            >
              <ol
                className="authoring-steps"
                aria-label={m.authoring_steps_list_label()}
              >
                {content.steps.map((step, index) => (
                  <StepCard
                    key={keys[index]}
                    sortableId={keys[index]!}
                    index={index}
                    content={content}
                    validation={validation}
                    vocabulary={vocabulary}
                    readOnly={readOnly}
                    expanded={
                      open.has(keys[index]!) || focus?.stepIndex === index
                    }
                    focused={focus?.stepIndex === index}
                    questions={highlights.filter(
                      (item) => item.stepId === step.id,
                    )}
                    problems={diagnosticsAt(validation, index)}
                    onToggle={() => toggle(keys[index]!)}
                    onChange={onChange}
                    onMove={(to) => onChange(moveStep(content, index, to))}
                    onDuplicate={() => onChange(duplicateStep(content, index))}
                    onRemove={() => onChange(removeStep(content, index))}
                    onRename={(to) =>
                      onChange(renameStep(content, step.id, to))
                    }
                    openCode={() => openCode(index)}
                    after={
                      readOnly ? null : (
                        <InsertSlot
                          index={index + 1}
                          count={content.steps.length}
                          receiving={receiving}
                          active={dropIndex === index + 1}
                          selected={target === index + 1}
                          onSelect={choose}
                        />
                      )
                    }
                  />
                ))}
              </ol>
            </SortableContext>
          </section>
        </div>
        {!readOnly && !small ? (
          <aside
            className="authoring-palette-panel"
            aria-label={m.authoring_palette_panel_label()}
          >
            {palette}
          </aside>
        ) : null}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
        {dragging?.kind === 'palette' ? (
          <DragPreview kind={dragging.item.kind} label={dragging.item.label} />
        ) : dragging?.kind === 'step' && content.steps[dragging.index] ? (
          <DragPreview
            kind={content.steps[dragging.index]!.kind}
            label={
              validation?.steps[dragging.index]?.description ??
              stepKinds[content.steps[dragging.index]!.kind].name()
            }
          />
        ) : null}
      </DragOverlay>
      <Dialog
        open={sheet && small}
        onOpenChange={(next) => {
          setSheet(next);
          // The chosen place only matters while the sheet is open.
          if (!next) setTarget(null);
        }}
      >
        <DialogContent
          ref={sheetRef}
          className="workflow-dialog authoring-sheet"
          // On touch, focusing the search box would open the on-screen keyboard over the list.
          initialFocus={(type) => (type === 'touch' ? sheetRef.current : true)}
        >
          <DialogTitle>{m.authoring_sheet_title()}</DialogTitle>
          <DialogDescription>
            {m.authoring_sheet_description({
              place: place(insertAt, content),
            })}
          </DialogDescription>
          {palette}
        </DialogContent>
      </Dialog>
    </DndContext>
  );
}
