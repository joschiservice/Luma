import type { CaseDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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

/**
 * Displays issue metadata and lets users copy its identifier. On its own it is a collapsed
 * disclosure; `embedded` shows the metadata directly inside a section that already names it.
 */
export function IssueRecordDetails({
  item,
  embedded = false,
}: {
  item: CaseDetail;
  embedded?: boolean;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const timestamp = (value: string) => <WorkspaceDate value={value} />;
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(item.id);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const content = (
    <>
      <div className="issue-record-content">
        <dl className="issue-record-subject">
          <div>
            <dt>
              <Package size={13} aria-hidden="true" />
              {item.subject.kind === 'sku'
                ? m.issues_record_sku()
                : m.issues_details_affected()}
            </dt>
            <dd>{item.subject.id}</dd>
          </div>
          <div>
            <dt>
              <Layers size={13} aria-hidden="true" /> {m.issues_details_scope()}
            </dt>
            <dd>
              {item.subject.scope.length ? (
                <ul>
                  {item.subject.scope.map((scope) => (
                    <li key={scope}>{scope}</li>
                  ))}
                </ul>
              ) : (
                m.issues_details_scope_none()
              )}
            </dd>
          </div>
        </dl>
        <dl className="issue-record-timeline">
          <div>
            <dt>
              <Clock3 size={13} aria-hidden="true" />{' '}
              {m.issues_details_first_detected()}
            </dt>
            <dd>{timestamp(item.detectedAt)}</dd>
          </div>
          <div>
            <dt>
              <Clock3 size={13} aria-hidden="true" />{' '}
              {m.issues_details_last_activity()}
            </dt>
            <dd>{timestamp(item.lastActivityAt)}</dd>
          </div>
        </dl>
        {item.diagnosis ? (
          <dl className="issue-record-reference">
            <div>
              <dt>{m.issues_meta_investigation_version()}</dt>
              <dd>{item.diagnosis.revision}</dd>
            </div>
          </dl>
        ) : null}
        <dl className="issue-record-reference">
          <div>
            <dt>
              <Hash size={13} aria-hidden="true" /> {m.issues_details_id()}
            </dt>
            <dd className="issue-id">
              <code>{item.id}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.issues_details_copy_id()}
                title={m.issues_details_copy_id()}
                onClick={() => void copyId()}
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
          ? m.issues_details_id_copied()
          : copyState === 'failed'
            ? m.issues_details_copy_failed()
            : ''}
      </span>
    </>
  );

  return embedded ? (
    <div className="issue-record-details" data-embedded="">
      {content}
    </div>
  ) : (
    <Disclosure className="issue-record-details">
      <summary>
        <FileText size={16} aria-hidden="true" />
        {m.issues_section_details()}
        <ChevronRight size={16} aria-hidden="true" />
      </summary>
      {content}
    </Disclosure>
  );
}
