import type {
  CaseSummary,
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  caseStateLabel,
  caseSummaryText,
  elapsed,
  freshnessLabel,
  issueKind,
  issueStatus,
  recordKindLabel,
  severityFullLabel,
  severityLabel,
  sourceLabel,
} from '@luma/ui/components/issues/case-presentation';
import {
  CollectionList,
  type CollectionListDensity,
} from '@luma/ui/components/primitives/collection-list';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { StatePill } from '@luma/ui/components/primitives/state';
import type { ReactElement, ReactNode } from 'react';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { collectionGroupLabel } from '../../kit/collections/groups';

/** Row properties a view without its own shows. */
export const issueProperties = [
  'class',
  'subject',
  'owner',
  'severity',
  'state',
  'lastActivity',
] as const;

/** Properties shown in the row's second line rather than in columns. */
const inlineProperties = new Set(['class', 'subject', 'owner']);

const attentionLabels: Readonly<Record<string, () => string>> = {
  approval: m.exceptions_attention_approval,
  manual_intervention: m.exceptions_attention_manual,
  uncertainty: m.exceptions_attention_uncertainty,
};

const diagnosisLabels: Readonly<
  Record<CaseSummary['diagnosisStatus'], () => string>
> = {
  pending: m.exceptions_diagnosis_pending,
  ready: m.exceptions_diagnosis_ready,
  insufficient_evidence: m.exceptions_diagnosis_insufficient,
  failed: m.exceptions_diagnosis_failed,
};

const resolutionLabels: Readonly<Record<string, () => string>> = {
  verified: m.exceptions_resolution_verified,
  human_disposition: m.exceptions_resolution_human,
};

const subjectLabels: Readonly<Record<string, () => string>> = {
  fulfillment: m.exceptions_subject_fulfillment,
  workflow_run: m.exceptions_subject_workflow_run,
};

/** Names the kind of record an issue is about. */
function subjectTypeLabel(kind: string) {
  return subjectLabels[kind]?.() ?? recordKindLabel(kind);
}

const issue = () => m.exceptions_area_issue();
const work = () => m.exceptions_area_work();
const evidence = () => m.exceptions_area_evidence();
const option =
  (labels: Readonly<Record<string, () => string>>) => (value: string) =>
    labels[value]?.() ?? value;

/** Names the issue catalog's fields and options in filters, sorts, groups and Display. */
export const issuePresentation: CatalogPresentation = {
  summary: { label: m.exceptions_field_summary, group: issue },
  urgency: { label: m.exceptions_field_urgency, group: work },
  class: {
    label: m.issues_filter_type,
    group: issue,
    option: (value) => issueKind({ class: value }).label,
  },
  state: {
    label: m.common_status,
    group: work,
    option: (value) => caseStateLabel(value as CaseSummary['state']),
  },
  severity: {
    label: m.issues_filter_severity,
    group: issue,
    option: (value) =>
      value === 'high' || value === 'medium' ? severityLabel(value) : value,
  },
  subject: { label: m.exceptions_field_subject, group: issue },
  subjectType: {
    label: m.exceptions_field_subject_type,
    group: issue,
    option: subjectTypeLabel,
  },
  owner: { label: m.exceptions_field_owner, group: work },
  source: { label: m.exceptions_field_source, group: evidence },
  attention: {
    label: m.exceptions_field_attention,
    group: work,
    option: option(attentionLabels),
  },
  freshness: {
    label: m.exceptions_field_freshness,
    description: m.exceptions_field_freshness_description,
    group: evidence,
    option: (value) =>
      value === 'fresh' || value === 'stale' || value === 'unknown'
        ? freshnessLabel(value)
        : value,
  },
  diagnosis: {
    label: m.exceptions_field_diagnosis,
    group: evidence,
    option: option(diagnosisLabels),
  },
  resolution: {
    label: m.exceptions_field_resolution,
    group: work,
    option: option(resolutionLabels),
  },
  detected: { label: m.exceptions_field_detected, group: issue },
  lastActivity: { label: m.exceptions_field_last_activity, group: work },
  waitingSince: {
    label: m.exceptions_field_waiting_since,
    description: m.exceptions_field_waiting_since_description,
    group: work,
  },
};

/**
 * Names one group of the issue list: an option's label, a member or the owner the rows name,
 * a source system, or the group without a value: no owner, no source or no value.
 */
export function issueGroupLabel({
  field,
  granularity,
  key,
  options,
  rows,
}: {
  field: string;
  granularity: CollectionGranularity | undefined;
  key: CollectionGroup['key'];
  options: RuntimeOptions;
  rows: readonly CaseSummary[];
}) {
  if (key === null && field === 'owner') return m.exceptions_owner_none();
  if (key === null && field === 'source') return m.exceptions_source_none();
  if (field === 'source' && typeof key === 'string') return sourceLabel(key);

  return collectionGroupLabel({
    presentation: issuePresentation,
    field,
    granularity,
    key,
    options,
    runtime: { owner: 'members' },
    name: (id) =>
      field === 'owner'
        ? (rows.find((row) => row.owner?.userId === id)?.owner?.name ??
          undefined)
        : undefined,
  });
}

export const segmentLabels = {
  needs_you: m.issues_view_needs_review,
  active: m.issues_view_open,
  history: m.issues_view_history,
} as const;

/** The list commands the issue inbox handles, for shortcut help. */
export const issueShortcuts = [
  'next',
  'previous',
  'open',
  'preview',
  'escape',
  'search',
  'filter',
  'help',
] as const;

function CaseTime({ at }: { at: string }) {
  return (
    <span className="case-row-time" title={at}>
      <time dateTime={at}>{elapsed(at)}</time>
    </span>
  );
}

/** Renders one issue property; type, record and owner go in the row's second line. */
export function issueProperty(item: CaseSummary, key: string): ReactNode {
  switch (key) {
    case 'class':
      return issueKind(item).label;
    case 'subject': {
      const subject = item.subject.label ?? m.common_not_reported();

      return (
        <span title={item.subject.id}>
          {item.sources.map(sourceLabel).join(' · ') ||
            m.issues_source_unknown()}{' '}
          · {recordKindLabel(item.subject.kind)} {subject}
        </span>
      );
    }
    case 'owner':
      return item.owner?.name
        ? `${m.authoring_coordination_owner()}: ${item.owner.name}`
        : null;
    case 'severity':
      return (
        <span className="issue-severity" data-severity={item.severity}>
          <span aria-hidden="true">{severityLabel(item.severity)}</span>
          <span className="sr-only">{severityFullLabel(item.severity)}</span>
        </span>
      );
    case 'state': {
      const status = issueStatus(item);

      return <StatePill state={status.state}>{status.label}</StatePill>;
    }
    case 'attention':
      return item.attention.required && item.attention.reason
        ? attentionLabels[item.attention.reason]?.()
        : null;
    case 'source':
      return item.sources.length
        ? item.sources.map(sourceLabel).join(' · ')
        : m.exceptions_source_none();
    case 'subjectType':
      return subjectTypeLabel(item.subject.kind);
    case 'freshness':
      return (
        <span className="issue-freshness" data-freshness={item.freshness}>
          {freshnessLabel(item.freshness)}
        </span>
      );
    case 'diagnosis':
      return diagnosisLabels[item.diagnosisStatus]();
    case 'resolution':
      return item.resolution ? resolutionLabels[item.resolution]?.() : null;
    case 'detected':
      return <CaseTime at={item.detectedAt} />;
    case 'lastActivity':
      return <CaseTime at={item.lastActivityAt} />;
    case 'waitingSince':
      return item.attention.requestedAt ? (
        <CaseTime at={item.attention.requestedAt} />
      ) : (
        m.exceptions_waiting_none()
      );
    default:
      return null;
  }
}

/**
 * The issue list: each issue's summary with its type, record and owner on a second line, and the
 * properties chosen in Display in columns. The page owns links, focus and the open issue.
 */
export function IssueList({
  label,
  items,
  link,
  properties = issueProperties,
  density = 'comfortable',
  current,
  focusedKey,
  empty,
}: {
  /** Names the list, such as a group's name; "Issues" by default. */
  label?: string | undefined;
  items: readonly CaseSummary[];
  /** The row's link to the issue. */
  link: (item: CaseSummary) => ReactElement;
  properties?: readonly string[] | undefined;
  density?: CollectionListDensity | undefined;
  /** The open issue. */
  current?: string | undefined;
  focusedKey?: string | undefined;
  empty?: ReactNode;
}) {
  const columns = properties.filter((key) => !inlineProperties.has(key));
  const inline = properties.filter((key) => inlineProperties.has(key));

  return (
    <CollectionList
      label={label ?? m.exceptions_rows_label()}
      variant="plain"
      density={density}
      items={items}
      itemKey={(item) => item.id}
      current={current}
      focusedKey={focusedKey}
      link={link}
      leading={(item) => (
        <DomainIcon domain={issueKind(item).domain} size="sm" />
      )}
      title={(item) => caseSummaryText(item.summary).replace(/\.+$/, '')}
      description={(item) => {
        const parts = inline
          .map((key) => [key, issueProperty(item, key)] as const)
          .filter(([, value]) => value !== null);

        return parts.length ? (
          <span className="case-row-subject">
            {parts.map(([key, value]) => (
              <span key={key}>{value}</span>
            ))}
          </span>
        ) : null;
      }}
      properties={columns}
      property={issueProperty}
      empty={empty}
    />
  );
}
