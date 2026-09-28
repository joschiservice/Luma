import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '@luma/ui/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border font-sans font-medium whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-[var(--ease-standard)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring not-disabled:active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),var(--shadow-control)] not-disabled:hover:bg-primary-hover',
        outline:
          'border-line-strong bg-surface-raised text-foreground shadow-[var(--shadow-control)] not-disabled:hover:border-[color-mix(in_srgb,var(--foreground)_24%,transparent)] not-disabled:hover:bg-[color-mix(in_srgb,var(--surface-raised)_92%,var(--foreground))]',
        ghost:
          'border-transparent text-fg-muted not-disabled:hover:bg-accent not-disabled:hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow-[var(--shadow-control)] not-disabled:hover:bg-[color-mix(in_srgb,var(--destructive)_88%,black)]',
      },
      size: {
        default: 'h-8 px-3 text-[13px] leading-5',
        sm: "h-7 px-2.5 text-[13px] leading-5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 px-4 text-sm',
        icon: 'size-8 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants>;

/**
 * Renders a styled button with shared variants and sizes, forwarding Base UI button props.
 * Coarse pointers receive 44px targets through the shared stylesheet.
 */
function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? 'default'}
      data-size={size ?? 'default'}
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
