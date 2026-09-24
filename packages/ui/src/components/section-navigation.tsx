import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Button } from './button';

export type SectionNavigationItem = {
  value: string;
  label: string;
  icon?: ReactNode;
};

/** Lists page sections and highlights the current location. The caller handles scrolling and focus. */
export function SectionNavigation({
  items,
  value,
  onValueChange,
  title = 'On this page',
  'aria-label': ariaLabel = title,
  className,
}: {
  items: readonly SectionNavigationItem[];
  value: string;
  onValueChange: (value: string) => void;
  title?: string;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn('grid gap-1 py-2', className)}>
      <p className="m-0 px-3 pb-2.5 text-[11px] font-normal text-muted-foreground">
        {title}
      </p>
      {items.map((item) => (
        <Button
          key={item.value}
          type="button"
          variant="ghost"
          aria-current={value === item.value ? 'location' : undefined}
          className="justify-start font-medium text-muted-foreground aria-[current=location]:bg-accent aria-[current=location]:font-semibold aria-[current=location]:text-primary"
          onClick={() => onValueChange(item.value)}
        >
          {item.icon ? (
            <span aria-hidden="true" className="shrink-0 [&_svg]:size-4">
              {item.icon}
            </span>
          ) : null}
          {item.label}
        </Button>
      ))}
    </nav>
  );
}
