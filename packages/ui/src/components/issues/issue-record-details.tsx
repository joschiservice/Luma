import type { CaseDetail } from '@luma/api-contract';
import {
  Check,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  Hash,
  Layers,
  Package,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';

/** Displays issue metadata and lets users copy its identifier. */
export function IssueRecordDetails({
  item,
  expanded = false,
}: {
  item: CaseDetail;
  expanded?: boolean;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const timestamp = (value: string) => <WorkspaceDate value={value} />;

  return (
    <Disclosure className="issue-record-details" open={expanded}>
      <summary>
        <FileText size={16} aria-hidden="true" />
        Issue details
        <ChevronRight size={16} aria-hidden="true" />
      </summary>
      <div className="issue-record-content">
        <dl className="issue-record-subject">
          <div>
            <dt>
              <Package size={13} aria-hidden="true" />
              {item.subject.kind === 'sku' ? 'SKU ID' : 'Affected item'}
            </dt>
            <dd>{item.subject.id}</dd>
          </div>
          <div>
            <dt>
              <Layers size={13} aria-hidden="true" /> Affected scope
            </dt>
            <dd>
              {item.subject.scope.length ? (
                <ul>
                  {item.subject.scope.map((scope) => (
                    <li key={scope}>{scope}</li>
                  ))}
                </ul>
              ) : (
                'No scope recorded'
              )}
            </dd>
          </div>
        </dl>
        <dl className="issue-record-timeline">
          <div>
            <dt>
              <Clock3 size={13} aria-hidden="true" /> First observed
            </dt>
            <dd>{timestamp(item.detectedAt)}</dd>
          </div>
          <div>
            <dt>
              <Clock3 size={13} aria-hidden="true" /> Last activity
            </dt>
            <dd>{timestamp(item.lastActivityAt)}</dd>
          </div>
        </dl>
        {item.diagnosis ? (
          <dl className="issue-record-reference">
            <div>
              <dt>Investigation revision</dt>
              <dd>{item.diagnosis.revision}</dd>
            </div>
          </dl>
        ) : null}
        <dl className="issue-record-reference">
          <div>
            <dt>
              <Hash size={13} aria-hidden="true" /> Issue ID
            </dt>
            <dd className="issue-id">
              <code>{item.id}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy issue ID"
                title="Copy issue ID"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(item.id);
                    setCopyState('copied');
                  } catch {
                    setCopyState('failed');
                  }
                }}
              >
                {copyState === 'copied' ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </Button>
            </dd>
          </div>
        </dl>
      </div>
      <span role="status">
        {copyState === 'copied'
          ? 'Issue ID copied'
          : copyState === 'failed'
            ? 'Could not copy. Select the issue ID to copy it manually.'
            : ''}
      </span>
    </Disclosure>
  );
}
