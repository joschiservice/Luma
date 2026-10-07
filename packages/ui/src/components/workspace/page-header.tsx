import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { WorkspacePageActions } from './workspace-page-actions';

/**
 * Introduces a page about one record or subject with its title, an optional one-line
 * description and page-level actions. Renders the page's only `h1`; pass `titleId` to
 * label a region. Top-level workspace pages use `PageTitle` instead.
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

/**
 * Names a top-level workspace page that the workspace bar already labels. Renders the
 * page's only `h1` for assistive technology without repeating it on screen, and shows
 * page-level actions in the workspace bar so the page starts with its own content.
 */
export function PageTitle({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {actions ? <WorkspacePageActions>{actions}</WorkspacePageActions> : null}
    </>
  );
}
