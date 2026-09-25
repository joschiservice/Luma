import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Displays a notice with a semantic tone. Set role to status or alert only when an announcement is needed. */
export function Alert({
  tone = 'neutral',
  className,
  children,
  ...props
}: ComponentProps<'div'> & {
  tone?: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
}) {
  const Icon =
    tone === 'success'
      ? CircleCheck
      : tone === 'warning' || tone === 'danger'
        ? CircleAlert
        : Info;

  return (
    <div
      {...props}
      data-slot="alert"
      data-tone={tone}
      className={cn('ui-alert', className)}
    >
      <Icon aria-hidden="true" />
      <div data-slot="alert-content">{children}</div>
    </div>
  );
}

/** Labels a notice without changing the page's heading hierarchy. */
export function AlertTitle(props: ComponentProps<'strong'>) {
  return <strong {...props} data-slot="alert-title" />;
}

/** Holds notice text or actions, with room for block content. */
export function AlertDescription(props: ComponentProps<'div'>) {
  return <div {...props} data-slot="alert-description" />;
}
