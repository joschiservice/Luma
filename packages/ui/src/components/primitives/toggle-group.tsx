import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';

import { cn } from '../../lib/utils';

/**
 * A compact segmented control: a labelled group of pressable options with arrow-key movement
 * between them. Base UI keeps `value` as an array; with the default single choice, pressing the
 * pressed option again reports an empty array, which callers that always need a choice ignore.
 * Use it to choose how the same content is shown, such as which source's report; use `Tabs`
 * when each option controls its own panel.
 */
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        'inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-[9px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] p-0.5',
        className,
      )}
      {...props}
    />
  );
}

/** One option of a toggle group; its text is its accessible name and `aria-pressed` its state. */
function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap text-fg-subtle transition-[background-color,color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        'data-pressed:bg-surface-raised data-pressed:text-foreground data-pressed:shadow-[0_1px_2px_rgb(16_37_83/0.08),0_0_0_1px_var(--line)] dark:data-pressed:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] dark:data-pressed:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
