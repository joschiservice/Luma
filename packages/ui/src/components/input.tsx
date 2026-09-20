import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@luma/ui/lib/utils';

export type InputProps = InputPrimitive.Props;

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
          'min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 font-sans text-base text-card-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30 motion-reduce:transition-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Input };
