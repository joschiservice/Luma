import type {
  CodeStepSuggestion,
  DraftProposal,
  GeneratedDraft,
  WorkflowDraft,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { IdentityError } from '../../../kit/identity/data';
import { workflowError } from '../data';
import {
  acceptProposal,
  describeWorkflow,
  draftsKey,
  generationAvailabilityOptions,
  refineDraft,
  rejectProposal,
  suggestCodeStep,
} from './data';
import { humanize } from './draft-model';

type Generation = GeneratedDraft['generation'];

// Explanations stay in this browser tab only; the server keeps provenance, not the model's text.
const recent = new Map<string, Generation>();

/** Explains that describing workflows is unavailable, using the server's reason. */
function Unavailable({ reason }: { reason: string | null }) {
  return (
    <Alert tone="neutral" role="status">
      {reason ?? m.authoring_describe_unavailable()}
    </Alert>
  );
}

/**
 * Drafts a workflow from a plain-language description. The result opens in the builder for
 * review; generation never publishes, activates or starts anything.
 */
export function DescribeDialog({
  organizationId,
  close,
}: {
  organizationId: string;
  close(): void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const availability = useQuery(generationAvailabilityOptions(organizationId));
  const [prompt, setPrompt] = useState('');
  const [request, setRequest] = useState<
    Parameters<typeof describeWorkflow>[1] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function submit() {
    const body = request ?? {
      id: crypto.randomUUID(),
      draftId: crypto.randomUUID(),
      prompt: prompt.trim(),
    };
    setRequest(body);
    setPending(true);
    setError('');
    abort.current = new AbortController();
    try {
      const result = await describeWorkflow(
        organizationId,
        body,
        abort.current.signal,
      );
      recent.set(result.draft.id, result.generation);
      await client.invalidateQueries({ queryKey: draftsKey(organizationId) });
      await navigate({
        to: '/app/$organizationId/workflows/drafts/$draftId',
        params: { organizationId, draftId: result.draft.id },
        search: { view: 'build' },
      });
    } catch (failure) {
      if (abort.current?.signal.aborted) return;
      setError(workflowError(failure));
      // A definite rejection can be edited; an uncertain one is retried unchanged.
      if (failure instanceof IdentityError && failure.status < 500)
        setRequest(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          abort.current?.abort();
          close();
        }
      }}
    >
      <DialogContent className="workflow-dialog">
        <DialogTitle>{m.authoring_describe_title()}</DialogTitle>
        <DialogDescription>
          {m.authoring_describe_description()}
        </DialogDescription>
        {availability.data && !availability.data.available ? (
          <Unavailable reason={availability.data.reason} />
        ) : null}
        <label className="authoring-field">
          {m.authoring_describe_prompt_label()}
          <Textarea
            rows={5}
            maxLength={4000}
            disabled={pending || !!request || !availability.data?.available}
            value={request?.prompt ?? prompt}
            placeholder={m.authoring_describe_prompt_placeholder()}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {pending ? <p role="status">{m.authoring_describe_pending()}</p> : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {m.authoring_describe_failed({ error })}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button
            variant="outline"
            onClick={() => {
              abort.current?.abort();
              close();
            }}
          >
            {m.common_cancel()}
          </Button>
          <Button
            disabled={
              pending ||
              !availability.data?.available ||
              !(request?.prompt ?? prompt).trim()
            }
            onClick={() => void submit()}
          >
            {pending
              ? m.authoring_describe_drafting()
              : request
                ? m.common_try_again()
                : m.authoring_describe_submit()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const changeLabels = {
  added: m.authoring_change_added,
  removed: m.authoring_change_removed,
  changed: m.authoring_change_changed,
  moved: m.authoring_change_moved,
} satisfies Record<DraftProposal['changes'][number]['change'], () => string>;

/**
 * Shows what a description produced and proposes changes from follow-up instructions. A
 * proposal is shown as step-level changes and applies only when accepted.
 */
export function GenerationAssistant({
  organizationId,
  draft,
  editable,
  saved,
  reload,
  highlight,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  editable: boolean;
  saved: boolean;
  reload(): void;
  highlight(questions: Generation['questions']): void;
}) {
  const availability = useQuery(generationAvailabilityOptions(organizationId));
  const generation = recent.get(draft.id);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<DraftProposal | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const highlighted = useRef(false);

  useEffect(() => {
    if (!generation || highlighted.current) return;
    highlighted.current = true;
    highlight(generation.questions);
  }, [generation, highlight]);

  async function propose() {
    setPending(true);
    setError('');
    try {
      const next = await refineDraft(organizationId, draft.id, {
        id: crypto.randomUUID(),
        revision: draft.revision,
        instruction: instruction.trim(),
      });
      setProposal(next);
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
    }
  }

  async function decide(accept: boolean) {
    if (!proposal) return;
    setPending(true);
    setError('');
    try {
      if (accept) {
        const result = await acceptProposal(
          organizationId,
          draft.id,
          proposal.id,
          {
            revision: proposal.baseRevision,
            saveId: crypto.randomUUID(),
          },
        );
        recent.set(result.draft.id, proposal);
        setProposal(null);
        setInstruction('');
        reload();
      } else {
        await rejectProposal(organizationId, draft.id, proposal.id);
        setProposal(null);
      }
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
    }
  }

  if (!generation && !editable) return null;

  return (
    <Card
      as="section"
      className="authoring-assistant"
      aria-labelledby="assistant-title"
    >
      <h2 id="assistant-title">
        {generation
          ? m.authoring_assistant_generated_title()
          : m.authoring_assistant_refine_title()}
      </h2>
      {generation ? (
        <>
          {generation.outcome === 'partial' ? (
            <Alert tone="warning">{m.authoring_assistant_partial()}</Alert>
          ) : null}
          {generation.questions.length ? (
            <div>
              <h3>{m.authoring_assistant_questions()}</h3>
              <ul>
                {generation.questions.map((item) => (
                  <li key={`${item.stepId}:${item.field}:${item.question}`}>
                    {item.question}{' '}
                    <span className="authoring-hint">
                      {m.authoring_assistant_question_where({
                        place: item.stepId ?? m.authoring_workflow_settings(),
                        field: humanize(item.field),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {generation.assumptions.length ? (
            <div>
              <h3>{m.authoring_assistant_assumptions()}</h3>
              <ul>
                {generation.assumptions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {generation.explanations.length ? (
            <Disclosure variant="plain" className="authoring-advanced">
              <summary>{m.authoring_assistant_explanations()}</summary>
              <dl className="authoring-code-summary">
                {generation.explanations.map((item) => (
                  <div key={item.stepId}>
                    <dt>{item.stepId}</dt>
                    <dd>{item.explanation}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          ) : null}
        </>
      ) : null}
      {editable ? (
        availability.data && !availability.data.available ? (
          <Unavailable reason={availability.data.reason} />
        ) : proposal ? (
          <div
            className="authoring-proposal"
            aria-label={m.authoring_proposal_title()}
          >
            <h3>{m.authoring_proposal_title()}</h3>
            {proposal.changes.length ? (
              <ul>
                {proposal.changes.map((item, index) => (
                  <li key={`${item.change}:${item.stepId}:${index}`}>
                    <Badge
                      tone={
                        item.change === 'added'
                          ? 'success'
                          : item.change === 'removed'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {changeLabels[item.change]()}
                    </Badge>{' '}
                    {item.summary}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{m.authoring_proposal_no_changes()}</p>
            )}
            {proposal.questions.length ? (
              <p className="authoring-hint">
                {m.authoring_proposal_questions({
                  questions: proposal.questions
                    .map((item) => item.question)
                    .join(' '),
                })}
              </p>
            ) : null}
            {proposal.diagnostics.some((item) => item.severity === 'error') ? (
              <Alert tone="warning">
                {m.authoring_proposal_problems({
                  count: proposal.diagnostics.filter(
                    (item) => item.severity === 'error',
                  ).length,
                })}
              </Alert>
            ) : null}
            <div className="workflow-dialog-actions">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void decide(false)}
              >
                {m.authoring_proposal_reject()}
              </Button>
              <Button
                disabled={
                  pending || !saved || proposal.baseRevision !== draft.revision
                }
                onClick={() => void decide(true)}
              >
                {m.authoring_proposal_accept()}
              </Button>
            </div>
            {proposal.baseRevision !== draft.revision ? (
              <p className="authoring-hint">{m.authoring_proposal_stale()}</p>
            ) : null}
          </div>
        ) : (
          <form
            className="authoring-refine"
            onSubmit={(event) => {
              event.preventDefault();
              void propose();
            }}
          >
            <label className="authoring-field">
              {m.authoring_refine_label()}
              <Textarea
                rows={2}
                maxLength={4000}
                disabled={pending || !saved}
                value={instruction}
                placeholder={m.authoring_refine_placeholder()}
                onChange={(event) => setInstruction(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              disabled={
                pending ||
                !saved ||
                !instruction.trim() ||
                !availability.data?.available
              }
            >
              {pending
                ? m.authoring_refine_pending()
                : m.authoring_refine_submit()}
            </Button>
            {!saved ? (
              <p className="authoring-hint">{m.authoring_wait_for_save()}</p>
            ) : null}
          </form>
        )
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {m.authoring_assistant_failed({ error })}
        </Alert>
      ) : null}
    </Card>
  );
}

/** Suggests Code Step source from a description; the author reviews it before applying. */
export function CodeStepSuggester({
  organizationId,
  draft,
  stepId,
  replace,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  stepId: string;
  replace(next: Pick<CodeStepSuggestion, 'source' | 'fields' | 'grants'>): void;
}) {
  const availability = useQuery(generationAvailabilityOptions(organizationId));
  const [description, setDescription] = useState('');
  const [suggestion, setSuggestion] = useState<CodeStepSuggestion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  if (availability.data && !availability.data.available) return null;

  return (
    <Disclosure variant="plain" className="authoring-advanced">
      <summary>{m.authoring_suggest_title()}</summary>
      <div className="authoring-step-form">
        <label className="authoring-field">
          {m.authoring_suggest_label()}
          <Textarea
            rows={2}
            maxLength={4000}
            value={description}
            placeholder={m.authoring_suggest_placeholder()}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={pending || !description.trim()}
          onClick={async () => {
            setPending(true);
            setError('');
            try {
              setSuggestion(
                await suggestCodeStep(organizationId, draft.id, {
                  id: crypto.randomUUID(),
                  revision: draft.revision,
                  stepId,
                  description: description.trim(),
                }),
              );
            } catch (failure) {
              setError(workflowError(failure));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending
            ? m.authoring_suggest_pending()
            : m.authoring_suggest_submit()}
        </Button>
        {error ? (
          <Alert tone="danger" role="alert">
            {m.authoring_suggest_failed({ error })}
          </Alert>
        ) : null}
        {suggestion ? (
          <div className="authoring-suggestion">
            <p>{suggestion.explanation}</p>
            <pre className="code-step-source">
              <code>{suggestion.source}</code>
            </pre>
            {suggestion.examples.length ? (
              <p className="authoring-hint">
                {m.authoring_suggest_examples({
                  examples: formatList(
                    suggestion.examples.map((item) =>
                      m.authoring_suggest_example({
                        name: item.name,
                        expected: JSON.stringify(item.expected),
                      }),
                    ),
                  ),
                })}
              </p>
            ) : null}
            {suggestion.diagnostics.length ? (
              <Alert tone="warning">
                {suggestion.diagnostics.map((item) => item.message).join(' ')}
              </Alert>
            ) : null}
            <Button
              onClick={() =>
                replace({
                  source: suggestion.source,
                  fields: suggestion.fields,
                  grants: suggestion.grants,
                })
              }
            >
              {m.authoring_suggest_apply()}
            </Button>
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}
