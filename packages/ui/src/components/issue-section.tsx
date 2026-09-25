import {
  CircleCheck,
  Files,
  History,
  Info,
  LayoutList,
  Play,
  Search,
} from 'lucide-react';
import { createContext, type ReactNode } from 'react';

export const issueSections = [
  { value: 'overview', label: 'Overview', icon: <LayoutList /> },
  { value: 'findings', label: 'Findings', icon: <Search /> },
  { value: 'execution', label: 'Execution', icon: <Play /> },
  { value: 'history', label: 'Audit history', icon: <History /> },
  { value: 'evidence', label: 'Evidence', icon: <Files /> },
  { value: 'resolution', label: 'Resolution', icon: <CircleCheck /> },
  { value: 'details', label: 'Issue details', icon: <Info /> },
] as const;

/** Groups a full-page issue section in a labeled card; embedded views keep their original content. */
export function IssueSection({
  section,
  children,
  status,
  enabled = true,
}: {
  section: (typeof issueSections)[number]['value'];
  children: ReactNode;
  status?: ReactNode;
  enabled?: boolean;
}) {
  if (!enabled) return <>{children}</>;
  const item = issueSections.find((item) => item.value === section)!;

  return (
    <section
      className="issue-section-card"
      data-issue-section={section}
      aria-label={item.label}
      tabIndex={-1}
    >
      <div className="issue-section-heading">
        <h2 className="issue-page-section-title">
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
        </h2>
        {status}
      </div>
      {children}
    </section>
  );
}

/** Connects full-page section actions to the page's scrolling and focus behavior. */
export const IssuePageNavigation = createContext<
  ((section: string) => void) | null
>(null);
