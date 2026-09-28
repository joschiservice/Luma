import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@luma/ui/lib/utils';

export type InputProps = InputPrimitive.Props;

/** Shared text-control appearance used by inputs, textareas and select triggers. */
export const controlClassName =
  'w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-surface-raised px-2.5 font-sans text-[13px] text-foreground shadow-[var(--shadow-control)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fg-subtle hover:border-[color-mix(in_srgb,var(--foreground)_28%,transparent)] focus-visible:border-signal focus-visible:ring-3 focus-visible:ring-signal/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20 motion-reduce:transition-none';

/**
 * Renders the shared text-input styling and forwards native input props, including
 * validation and disabled state.
 */
function Input({ className, ...props }: InputProps) {
  return (
    <InputPrimitive
      data-slot="input"
      className={(state) =>
        cn(
          controlClassName,
          'h-8 py-1',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Input };
