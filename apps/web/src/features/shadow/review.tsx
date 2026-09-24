import { shadowReviewSchema } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import { CaseNotice } from '@luma/ui/components/case-investigation';
import { Field, FieldGroup, FieldLabel } from '@luma/ui/components/field';
import { Input } from '@luma/ui/components/input';
import { IssueCollection } from '@luma/ui/components/issue-collection';
import { Select } from '@luma/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

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
  const [occurredAt, setOccurredAt] = useState(() =>
    new Date().toISOString().slice(0, 23),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<ShadowReview>();
  const lock = useRef(false);
  const unavailable = shadowAccessDenied(history.error);

  async function submit() {
    if (lock.current || unavailable) return;
    let body: ShadowReview;
    try {
      if (!retry && (!needed || !eligible))
        throw new Error(
          'Assess whether action was needed and whether the case was eligible.',
        );
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
          occurredAt: new Date(`${occurredAt}Z`).toISOString(),
          feedback: feedback === 'none' ? null : feedback,
        });
      if (
        Date.parse(body.occurredAt) < Date.parse(evaluation.createdAt) ||
        Date.parse(body.occurredAt) > Date.now()
      )
        throw new Error(
          'The observation must follow this evaluation and cannot be in the future.',
        );
    } catch (error) {
      setError(
        error instanceof Error && !('issues' in error)
          ? error.message
          : 'Check the action fields, target ID and selected evidence.',
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
      <CaseNotice error title="Evidence unavailable">
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
      <h4>Compare with the operator’s action</h4>
      <p>
        Record what happened after this prediction. Saved reviews cannot be
        edited.
      </p>
      <fieldset disabled={pending || !!retry} className="shadow-fields">
        <FieldGroup>
          <div className="shadow-form-grid">
            <Field>
              <FieldLabel htmlFor={`${id}-needed`}>
                Was an action needed?
              </FieldLabel>
              <Select
                id={`${id}-needed`}
                aria-label="Was an action needed?"
                value={needed}
                onValueChange={(v) => setNeeded(v ?? '')}
                options={[
                  { value: '', label: 'Choose an assessment' },
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-eligible`}>
                Was this case eligible?
              </FieldLabel>
              <Select
                id={`${id}-eligible`}
                aria-label="Was this case eligible?"
                value={eligible}
                onValueChange={(v) => setEligible(v ?? '')}
                options={[
                  { value: '', label: 'Choose an assessment' },
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`${id}-action`}>
              Observed operator action
            </FieldLabel>
            <Select
              id={`${id}-action`}
              aria-label="Observed operator action"
              value={choice}
              onValueChange={(v) => setChoice(v ?? 'unknown')}
              options={[
                { value: 'unknown', label: 'Not observed' },
                ...(action
                  ? [{ value: 'same', label: 'Same as the proposed action' }]
                  : []),
                { value: 'different', label: 'Record another action' },
              ]}
            />
          </Field>
          {choice === 'different' ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-capability`}>
                  Action capability
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
                  <FieldLabel htmlFor={`${id}-kind`}>Target type</FieldLabel>
                  <Input
                    id={`${id}-kind`}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-target`}>Target ID</FieldLabel>
                  <Input
                    id={`${id}-target`}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                </Field>
              </div>
              <ActionFieldsEditor
                title="Parameters"
                rows={parameters}
                change={setParameters}
              />
              <ActionFieldsEditor
                title="Expected result"
                rows={expected}
                change={setExpected}
              />
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${id}-when`}>Observed at (UTC)</FieldLabel>
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
            <legend>Supporting incident evidence</legend>
            {history.isPending ? (
              <p role="status">Loading evidence…</p>
            ) : history.error && !history.data ? (
              <CaseNotice error title="Evidence could not be loaded">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void history.refetch()}
                >
                  Retry evidence
                </Button>
              </CaseNotice>
            ) : !history.data?.evidence.length ? (
              <p>No retained evidence is available for this case yet.</p>
            ) : (
              <>
                <p role="status">{refs.length} evidence records selected</p>
                <IssueCollection
                  title="Supporting incident evidence"
                  noun="incident evidence records"
                  items={history.data.evidence}
                  hasMore={history.data.hasMoreEvidence}
                  loading={history.isFetching}
                  onLoadMore={() => setPages((value) => value + 1)}
                  filters={[
                    {
                      label: 'Provider',
                      value: (evidence) =>
                        evidence.source?.provider ?? 'Observation',
                    },
                    {
                      label: 'Selection',
                      value: (evidence) =>
                        refs.includes(evidence.id)
                          ? 'Selected'
                          : 'Not selected',
                    },
                  ]}
                  notice={
                    <>
                      <p role="status">
                        {refs.length} evidence records selected
                      </p>
                      {history.error ? (
                        <CaseNotice error title="Evidence could not be loaded">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void history.refetch()}
                          >
                            Retry evidence
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
                            : 'Observation'}{' '}
                          · {new Date(evidence.observedAt).toLocaleString()}
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
              Would you trust this recommendation?
            </FieldLabel>
            <Select
              id={`${id}-feedback`}
              aria-label="Would you trust this recommendation?"
              value={feedback}
              onValueChange={(v) => setFeedback(v ?? 'none')}
              options={[
                { value: 'none', label: 'No feedback' },
                { value: 'trust', label: 'Trust' },
                { value: 'distrust', label: 'Distrust' },
                { value: 'unsure', label: 'Unsure' },
              ]}
            />
          </Field>
        </FieldGroup>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      {retry ? (
        <p>The save is uncertain. Retry sends the same review.</p>
      ) : null}
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
          ? 'Saving comparison…'
          : retry
            ? 'Retry saving comparison'
            : 'Save operator comparison'}
      </Button>
    </form>
  );
}
