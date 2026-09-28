import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

/**
 * Introduces a workspace page with its title, an optional one-line description and
 * page-level actions. Renders the page's only `h1`; pass `titleId` to label a region.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  titleId,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={cn('page-header', className)}>
      <div className="page-header-main">
        {icon ? <div className="page-header-icon">{icon}</div> : null}
        <div className="page-header-copy">
          <h1 id={titleId}>{title}</h1>
          {description ? (
            <p className="page-header-description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
