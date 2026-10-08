import { useRender } from '@base-ui/react/use-render';
import { m } from '@luma/i18n/messages';
import { ArrowLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { type Domain, DomainIcon } from '../primitives/domain-icon';
import { WorkspaceBreadcrumb } from './workspace-breadcrumb';
import { WorkspacePageActions } from './workspace-page-actions';

/** One labeled fact in a record summary, such as an order's total or when it was placed. */
export type RecordFact = {
  key: string;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
};

function CrumbLink({
  render,
  className,
  label,
  children,
}: {
  render: ReactElement;
  className: string;
  label?: string;
  children: ReactNode;
}) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: { className, 'aria-label': label, title: label, children },
  });
}

/**
 * Introduces a page about one record. The workspace breadcrumb names it as "Section › Record",
 * the page's only `h1` repeats that name for assistive technology without showing it twice, and
 * `actions` sit in the workspace bar. `status`, `description` and `facts` give the record's
 * state, origin and key values at a glance. The section shows its domain tile, or `icon` for
 * areas without one. `section.link` and `back` are router links without children; pass `back`
 * when the reader arrived from another record so they can return to it.
 */
export function RecordHeader({
  section,
  title,
  back,
  actions,
  status,
  description,
  facts = [],
  children,
}: {
  section: {
    label: string;
    domain?: Domain;
    icon?: LucideIcon;
    link: ReactElement;
  };
  title: string;
  back?: ReactElement | undefined;
  actions?: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  facts?: RecordFact[];
  children?: ReactNode;
}) {
  return (
    <>
      <WorkspaceBreadcrumb>
        {back ? (
          <CrumbLink
            render={back}
            className="record-crumb-back"
            label={m.ui_record_back()}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </CrumbLink>
        ) : null}
        <CrumbLink render={section.link} className="record-crumb-section">
          {section.domain ? (
            <DomainIcon domain={section.domain} size="xs" />
          ) : section.icon ? (
            <section.icon size={15} aria-hidden="true" />
          ) : null}
          <span>{section.label}</span>
        </CrumbLink>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page" title={title}>
          {title}
        </span>
      </WorkspaceBreadcrumb>
      <h1 className="sr-only">{title}</h1>
      {actions ? <WorkspacePageActions>{actions}</WorkspacePageActions> : null}
      {status || description || facts.length || children ? (
        <header className="record-header">
          {status || description ? (
            <div className="record-header-status">
              {status}
              {description ? (
                <p className="record-header-description">{description}</p>
              ) : null}
            </div>
          ) : null}
          {facts.length ? (
            <dl className="record-facts">
              {facts.map(({ key, icon: Icon, label, value }) => (
                <div key={key}>
                  <dt>
                    <Icon aria-hidden="true" />
                    {label}
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {children}
        </header>
      ) : null}
    </>
  );
}
