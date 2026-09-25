import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cn } from '@luma/ui/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useId } from 'react';

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export type SelectProps<Value extends string = string> = Omit<
  SelectPrimitive.Root.Props<Value>,
  'children' | 'items' | 'multiple'
> &
  Pick<
    SelectPrimitive.Trigger.Props,
    'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'
  > & {
    options: readonly SelectOption<Value>[];
    placeholder?: string;
    className?: string;
  };

/**
 * Chooses one value from labeled options, with keyboard navigation and form support.
 * Supply a visible label or aria-label. Option values must be unique; null shows the placeholder.
 */
export function Select<Value extends string>({
  options,
  placeholder = 'Select an option',
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: SelectProps<Value>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;

  return (
    <SelectPrimitive.Root items={options} {...props} id={id}>
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cn(
          'group flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-1.5 text-left font-sans text-xs text-card-foreground outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 data-[popup-open]:border-ring data-[disabled]:cursor-not-allowed data-[disabled]:border-border data-[disabled]:bg-muted data-[disabled]:text-muted-foreground data-[placeholder]:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30 motion-reduce:transition-none',
          className,
        )}
      >
        <SelectPrimitive.Value className="truncate">
          {(value: Value | null) =>
            options.find((option) => option.value === value)?.label ??
            placeholder
          }
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground transition-transform group-data-[popup-open]:rotate-180 motion-reduce:transition-none">
          <ChevronDown size={16} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <SelectPrimitive.Popup className="max-w-[var(--available-width)] min-w-[var(--anchor-width)] overflow-hidden rounded-lg border border-border bg-popover font-sans text-xs text-popover-foreground shadow-lg outline-none transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none">
            <SelectPrimitive.List
              aria-label={ariaLabel}
              aria-labelledby={ariaLabel ? undefined : (ariaLabelledBy ?? id)}
              className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1"
            >
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="relative flex min-h-9 cursor-default items-center rounded-md py-1.5 pr-9 pl-3 outline-none select-none data-[selected]:font-medium data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:text-muted-foreground data-[disabled]:opacity-50"
                >
                  <SelectPrimitive.ItemText className="break-words">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-3 text-primary">
                    <Check size={15} aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
