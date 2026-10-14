import { Select as SelectPrimitive } from '@base-ui/react/select';
import { m } from '@luma/i18n/messages';
import { cn } from '@luma/ui/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useId } from 'react';

import { controlClassName } from './input';

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
  placeholder,
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
          controlClassName,
          'group flex h-8 items-center justify-between gap-2 py-1 text-left data-[popup-open]:border-signal data-[popup-open]:ring-3 data-[popup-open]:ring-signal/20 data-[disabled]:cursor-not-allowed data-[disabled]:bg-muted data-[disabled]:text-muted-foreground data-[placeholder]:text-fg-subtle',
          className,
        )}
      >
        <SelectPrimitive.Value className="truncate">
          {(value: Value | null) =>
            options.find((option) => option.value === value)?.label ??
            placeholder ??
            m.ui_select_placeholder()
          }
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon className="shrink-0 text-fg-subtle transition-transform duration-150 group-data-[popup-open]:rotate-180 motion-reduce:transition-none">
          <ChevronDown size={15} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          sideOffset={6}
          alignItemWithTrigger={false}
          // Above responsive pickers (z-index 60), which hold selects such as a condition's operator.
          className="z-[70] outline-none"
        >
          <SelectPrimitive.Popup className="lu-popover max-w-[var(--available-width)] min-w-[var(--anchor-width)] overflow-hidden font-sans text-[13px]">
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
                  className="lu-menu-item relative pr-8 data-[selected]:font-medium"
                >
                  <SelectPrimitive.ItemText className="break-words">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2.5 text-signal">
                    <Check size={14} aria-hidden="true" />
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
