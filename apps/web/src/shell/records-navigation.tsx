import { m } from '@luma/i18n/messages';
import { ChevronRight, Database } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { SidebarLinkLabel } from '../kit/layout/sidebar-link-label';

/** Groups record destinations, initially expanded when the current page is a record. */
export function RecordsNavigation({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(active);
  const id = useId();

  return (
    <section className="sidebar-section">
      <button
        type="button"
        className="sidebar-link sidebar-records-toggle"
        data-label={m.identity_nav_records()}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        <Database className="sidebar-link-icon" size={16} aria-hidden="true" />
        <SidebarLinkLabel>{m.identity_nav_records()}</SidebarLinkLabel>
        <ChevronRight
          className="sidebar-records-chevron"
          size={14}
          aria-hidden="true"
        />
      </button>
      <ul id={id} className="sidebar-list" hidden={!expanded}>
        {children}
      </ul>
    </section>
  );
}
