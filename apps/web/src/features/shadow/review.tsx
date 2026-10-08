import './shadow.css';

import { shadowReviewSchema } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { IssueCollection } from '@luma/ui/components/issues/issue-collection';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue, workspaceInstant } from '@luma/ui/lib/timezone';
import { useQuery } from '@tanstack/react-query';
import { useContext, useId, useRef, useState } from 'react';

import { historyOptions } from '../exceptions/observation-data';
import { IdentityError } from '../identity/data';
import {
  candidateAction,
  reviewShadow,
  shadowAccessDenied,
  shadowError,
  type ShadowEvaluation,
  type ShadowReview,
} from './data';
import { ActionFieldsEditor, fieldRows, readFields } from './review-fields';

/** Captures an explicit operator assessment with incident evidence and immutable retry semantics. */
export function ShadowReviewForm({
  organizationId,
  evaluation,
  saved,
  accessLost,
}: {
  organizationId: string;
  evaluation: ShadowEvaluation;
  saved: () => Promise<void>;
  accessLost: (error: unknown) => void;
}) {
  const id = useId();
  const timeZone = useContext(WorkspaceTimezone);
  const [pages, setPages] = useState(1);
  const history = useQuery(
    historyOptions(organizationId, evaluation.incidentId, pages),
  );
  const action = candidateAction(evaluation);
  const [needed, setNeeded] = useState('');
  const [eligible, setEligible] = useState('');
  const [choice, setChoice] = useState('unknown');
  const [feedback, setFeedback] = useState('none');
  const [refs, setRefs] = useState<string[]>([]);
  const [capability, setCapability] = useState(action?.capability ?? '');
  const [kind, setKind] = useState(action?.target.kind ?? 'order');
  const [target, setTarget] = useState(action?.target.id ?? '');
  const [parameters, setParameters] = useState(() =>
    fieldRows(action?.parameters ?? {}),
  );
  const [expected, setExpected] = useState(() =>
    fieldRows(action?.expectedPostcondition ?? {}),
  );
  const [occurredAt, setOccurredAt] = useState(() => {
    const now = new Date();

    return `${workspaceDateValue(now, timeZone, true)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<ShadowReview>();
  const lock = useRef(false);
  const unavailable = shadowAccessDenied(history.error);
  const selectedLabel = refs.length
    ? m.shadow_review_evidence_selected({ count: refs.length })
    : m.shadow_review_evidence_none_selected();

  async function submit() {
    if (lock.current || unavailable) return;
    let body: ShadowReview;
    try {
      if (!retry && (!needed || !eligible))
        throw new Error(m.shadow_review_error_answers());
      body =
        retry ??
        shadowReviewSchema.parse({
          actionNeeded: needed === 'yes',
          eligible: eligible === 'yes',
          operatorAction:
            choice === 'same'
              ? action
              : choice === 'different'
                ? {
                    capability,
                    target: { kind, id: target },
                    parameters: readFields(parameters),
                    expectedPostcondition: readFields(expected),
                  }
                : null,
          evidenceRefs: refs,
          occurredAt: workspaceInstant(occurredAt, timeZone),
          feedback: feedback === 'none' ? null : feedback,
        });
      if (
        Date.parse(body.occurredAt) < Date.parse(evaluation.createdAt) ||
        Date.parse(body.occurredAt) > Date.now()
      )
        throw new Error(m.shadow_review_error_time());
    } catch (error) {
      setError(
        error instanceof Error && !('issues' in error)
          ? error.message
          : m.shadow_review_error_fields(),
      );

      return;
    }
    lock.current = true;
    setPending(true);
    setError('');
    try {
      await reviewShadow(organizationId, evaluation.id, body);
      setRetry(undefined);
      await saved();
    } catch (error) {
      setError(shadowError(error));
      if (!(error instanceof IdentityError) || error.status >= 500)
        setRetry(body);
      if (shadowAccessDenied(error)) accessLost(error);
      if (error instanceof IdentityError && error.status === 409) await saved();
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (unavailable)
    return (
      <CaseNotice error title={m.shadow_review_evidence_failed()}>
        {shadowError(history.error)}
      </CaseNotice>
    );

  return (
    <form
      className="shadow-review"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4>{m.shadow_review_title()}</h4>
      <p>{m.shadow_review_description()}</p>
      <fieldset disabled={pending || !!retry} className="shadow-fields">
        <FieldGroup>
          <div className="shadow-form-grid">
            <Field>
              <FieldLabel htmlFor={`${id}-needed`}>
                {m.shadow_review_needed()}
              </FieldLabel>
              <Select
                id={`${id}-needed`}
                aria-label={m.shadow_review_needed()}
                value={needed}
                onValueChange={(v) => setNeeded(v ?? '')}
                options={[
                  { value: '', label: m.shadow_review_choose() },
                  { value: 'yes', label: m.common_yes() },
                  { value: 'no', label: m.common_no() },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-eligible`}>
                {m.shadow_review_fits()}
              </FieldLabel>
              <Select
                id={`${id}-eligible`}
                aria-label={m.shadow_review_fits()}
                value={eligible}
                onValueChange={(v) => setEligible(v ?? '')}
                options={[
                  { value: '', label: m.shadow_review_choose() },
                  { value: 'yes', label: m.common_yes() },
                  { value: 'no', label: m.common_no() },
                ]}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`${id}-action`}>
              {m.shadow_review_action()}
            </FieldLabel>
            <Select
              id={`${id}-action`}
              aria-label={m.shadow_review_action()}
              value={choice}
              onValueChange={(v) => setChoice(v ?? 'unknown')}
              options={[
                { value: 'unknown', label: m.shadow_review_action_unknown() },
                ...(action
                  ? [{ value: 'same', label: m.shadow_review_action_same() }]
                  : []),
                { value: 'different', label: m.shadow_review_action_other() },
              ]}
            />
          </Field>
          {choice === 'different' ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-capability`}>
                  {m.shadow_review_change_type()}
                </FieldLabel>
                <Input
                  id={`${id}-capability`}
                  value={capability}
                  onChange={(e) => setCapability(e.target.value)}
                  required
                />
              </Field>
              <div className="shadow-form-grid">
                <Field>
                  <FieldLabel htmlFor={`${id}-kind`}>
                    {m.shadow_review_record_type()}
                  </FieldLabel>
                  <Input
                    id={`${id}-kind`}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-target`}>
                    {m.shadow_review_record_id()}
                  </FieldLabel>
                  <Input
                    id={`${id}-target`}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                </Field>
              </div>
              <ActionFieldsEditor
                group="parameters"
                rows={parameters}
                change={setParameters}
              />
              <ActionFieldsEditor
                group="expected"
                rows={expected}
                change={setExpected}
              />
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${id}-when`}>
              {m.shadow_review_when({ timeZone })}
            </FieldLabel>
            <Input
              id={`${id}-when`}
              type="datetime-local"
              step="0.001"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
              required
            />
          </Field>
          <fieldset className="shadow-fields">
            <legend>{m.shadow_review_evidence_title()}</legend>
            {history.isPending ? (
              <p role="status">{m.shadow_review_evidence_loading()}</p>
            ) : history.error && !history.data ? (
              <CaseNotice error title={m.shadow_review_evidence_failed()}>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void history.refetch()}
                >
                  {m.common_retry()}
                </Button>
              </CaseNotice>
            ) : !history.data?.evidence.length ? (
              <p>{m.shadow_review_evidence_empty()}</p>
            ) : (
              <>
                <p role="status">{selectedLabel}</p>
                <IssueCollection
                  title={m.shadow_review_evidence_title()}
                  noun={m.shadow_review_evidence_noun()}
                  items={history.data.evidence}
                  hasMore={history.data.hasMoreEvidence}
                  loading={history.isFetching}
                  onLoadMore={() => setPages((value) => value + 1)}
                  filters={[
                    {
                      label: m.common_source(),
                      value: (evidence) =>
                        evidence.source?.provider ??
                        m.shadow_review_no_source(),
                    },
                    {
                      label: m.shadow_review_filter_selection(),
                      value: (evidence) =>
                        refs.includes(evidence.id)
                          ? m.shadow_review_selected()
                          : m.shadow_review_not_selected(),
                    },
                  ]}
                  notice={
                    <>
                      <p role="status">{selectedLabel}</p>
                      {history.error ? (
                        <CaseNotice
                          error
                          title={m.shadow_review_evidence_failed()}
                        >
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void history.refetch()}
                          >
                            {m.common_retry()}
                          </Button>
                        </CaseNotice>
                      ) : null}
                    </>
                  }
                  renderItems={(items) =>
                    items.map((evidence) => (
                      <label className="shadow-evidence" key={evidence.id}>
                        <input
                          type="checkbox"
                          disabled={pending || !!retry}
                          checked={refs.includes(evidence.id)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setRefs((current) =>
                              checked
                                ? [...current, evidence.id]
                                : current.filter((ref) => ref !== evidence.id),
                            );
                          }}
                        />
                        <span>
                          {evidence.source
                            ? `${evidence.source.provider} · ${evidence.source.resource}`
                            : m.shadow_review_no_source()}{' '}
                          · <WorkspaceDate value={evidence.observedAt} />
                          <code>{evidence.id}</code>
                        </span>
                      </label>
                    ))
                  }
                />
              </>
            )}
          </fieldset>
          <Field>
            <FieldLabel htmlFor={`${id}-feedback`}>
              {m.shadow_review_trust()}
            </FieldLabel>
            <Select
              id={`${id}-feedback`}
              aria-label={m.shadow_review_trust()}
              value={feedback}
              onValueChange={(v) => setFeedback(v ?? 'none')}
              options={[
                { value: 'none', label: m.shadow_trust_none() },
                { value: 'trust', label: m.shadow_trust_trust() },
                { value: 'distrust', label: m.shadow_trust_distrust() },
                { value: 'unsure', label: m.shadow_trust_unsure() },
              ]}
            />
          </Field>
        </FieldGroup>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      {retry ? <p>{m.shadow_review_uncertain()}</p> : null}
      <Button
        type="submit"
        disabled={
          pending ||
          history.isError ||
          history.isPending ||
          (!retry && (!needed || !eligible || !refs.length))
        }
      >
        {pending
          ? m.shadow_review_saving()
          : retry
            ? m.shadow_review_retry()
            : m.shadow_review_save()}
      </Button>
    </form>
  );
}
