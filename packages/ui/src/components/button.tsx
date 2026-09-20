import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '@luma/ui/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent font-sans text-sm font-semibold transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground enabled:hover:bg-primary-hover',
        outline:
          'border-input bg-card text-card-foreground enabled:hover:bg-secondary',
        ghost: 'text-foreground enabled:hover:bg-secondary',
        destructive:
          'bg-destructive text-destructive-foreground enabled:hover:bg-destructive/90',
      },
      size: {
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-9 px-3 py-1.5 text-xs',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants>;

/** Renders a styled button with shared variants and sizes, forwarding Base UI button props. */
function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={(state) =>
        cn(
          buttonVariants({ variant, size }),
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Button, buttonVariants };
