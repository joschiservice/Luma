import type { ComponentProps, HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

/** Groups related content with shared surface and spacing. Choose a semantic element for labeled sections. */
export function Card({
  as: Element = 'div',
  variant = 'default',
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'aside';
  variant?: 'default' | 'subtle' | 'plain';
}) {
  return (
    <Element
      {...props}
      data-slot="card"
      data-variant={variant}
      className={cn('ui-card', className)}
    />
  );
}

/** Aligns a card's heading and optional actions, wrapping on narrow screens. */
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-slot="card-header"
      className={cn('ui-card-header', className)}
    />
  );
}

/** Gives a card a heading at the level appropriate to its surrounding document. */
export function CardTitle({
  as: Element = 'h2',
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' | 'h4' }) {
  return (
    <Element
      {...props}
      data-slot="card-title"
      className={cn('ui-card-title', className)}
    />
  );
}

/** Presents supporting card context beneath its title. */
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      {...props}
      data-slot="card-description"
      className={cn('ui-card-description', className)}
    />
  );
}

/** Contains card content and trims margins at its outer edges. */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-slot="card-content"
      className={cn('ui-card-content', className)}
    />
  );
}

/** Groups card actions and supporting footer content. */
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-slot="card-footer"
      className={cn('ui-card-footer', className)}
    />
  );
}
