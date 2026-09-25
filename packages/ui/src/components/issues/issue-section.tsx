import {
  ChevronDown,
  CircleCheck,
  Files,
  History,
  Info,
  LayoutList,
  Play,
  Search,
} from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '../primitives/card';
import { Disclosure } from '../primitives/disclosure';

/** Enables compact, collapsible supporting sections inside an issue inspector. */
export const IssuePanelSections = createContext(false);

export const issueSections = [
  { value: 'overview', label: 'Overview', icon: <LayoutList /> },
  { value: 'findings', label: 'Findings', icon: <Search /> },
  { value: 'execution', label: 'Execution', icon: <Play /> },
  { value: 'history', label: 'Audit history', icon: <History /> },
  { value: 'evidence', label: 'Evidence', icon: <Files /> },
  { value: 'resolution', label: 'Resolution', icon: <CircleCheck /> },
  { value: 'details', label: 'Issue details', icon: <Info /> },
] as const;

/** Groups issue content in labeled cards; inspector sections collapse while full-page sections stay open. */
export function IssueSection({
  section,
  children,
  status,
  preview,
  enabled = true,
}: {
  section: (typeof issueSections)[number]['value'];
  children: ReactNode;
  status?: ReactNode;
  preview?: ReactNode;
  enabled?: boolean;
}) {
  const panel = useContext(IssuePanelSections);
  if (!enabled) return <>{children}</>;
  const item = issueSections.find((item) => item.value === section)!;

  return (
    <Card
      as="section"
      className="issue-section-card"
      data-issue-section={section}
      aria-label={item.label}
      tabIndex={-1}
    >
      {panel && section !== 'overview' ? (
        <Disclosure
          variant="plain"
          className="issue-section-disclosure"
          open={section === 'findings'}
        >
          <summary className="issue-section-trigger">
            <CardTitle>
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </CardTitle>
            {preview ? (
              <span className="issue-section-preview">{preview}</span>
            ) : null}
            <ChevronDown
              className="issue-section-chevron"
              size={16}
              aria-hidden="true"
            />
          </summary>
          {status ? <div className="issue-section-status">{status}</div> : null}
          <CardContent>{children}</CardContent>
        </Disclosure>
      ) : (
        <>
          <CardHeader>
            <CardTitle>
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </CardTitle>
            {status}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </>
      )}
    </Card>
  );
}

/** Connects full-page section actions to the page's scrolling and focus behavior. */
export const IssuePageNavigation = createContext<
  ((section: string) => void) | null
>(null);
