import { m } from '@luma/i18n/messages';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

export type SectionNavigationItem = {
  value: string;
  label: string;
  icon?: ReactNode;
  group?: string;
};

/** Lists page sections and highlights the current location. The caller handles scrolling and focus. */
export function SectionNavigation({
  items,
  value,
  onValueChange,
  title = m.ui_section_navigation_title(),
  'aria-label': ariaLabel = title,
  className,
  renderItem,
}: {
  items: readonly SectionNavigationItem[];
  value: string;
  onValueChange?: (value: string) => void;
  title?: string;
  'aria-label'?: string;
  className?: string;
  renderItem?: (item: SectionNavigationItem, className: string) => ReactNode;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn('section-navigation', className)}>
      {items.map((item, index) => {
        const heading =
          item.group && item.group !== items[index - 1]?.group
            ? item.group
            : null;
        const itemClassName = 'section-navigation-item';

        return (
          <div className="section-navigation-entry" key={item.value}>
            {heading ? (
              <p className="section-navigation-heading">{heading}</p>
            ) : null}
            {!item.group && item === items[0] ? (
              <p className="section-navigation-heading">{title}</p>
            ) : null}
            {renderItem ? (
              renderItem(item, itemClassName)
            ) : (
              <button
                type="button"
                aria-current={value === item.value ? 'location' : undefined}
                className={itemClassName}
                onClick={() => onValueChange?.(item.value)}
              >
                {item.icon ? (
                  <span aria-hidden="true" className="section-navigation-icon">
                    {item.icon}
                  </span>
                ) : null}
                {item.label}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
