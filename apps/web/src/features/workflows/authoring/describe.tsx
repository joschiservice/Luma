import type {
  CodeStepSuggestion,
  DraftProposal,
  GeneratedDraft,
  WorkflowDraft,
} from '@luma/api-contract';
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

import { IdentityError } from '../../identity/data';
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
      {reason ?? 'Describing workflows is unavailable in this workspace.'}
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
        <DialogTitle>Describe a workflow</DialogTitle>
        <DialogDescription>
          Say what should happen. Luma drafts the steps using only what this
          workspace has installed, and lists its assumptions and questions for
          you to review. Nothing runs until you publish and activate it.
        </DialogDescription>
        {availability.data && !availability.data.available ? (
          <Unavailable reason={availability.data.reason} />
        ) : null}
        <label className="authoring-field">
          What should happen?
          <Textarea
            rows={5}
            maxLength={4000}
            disabled={pending || !!request || !availability.data?.available}
            value={request?.prompt ?? prompt}
            placeholder="When a SKU drops below 20 units, draft a purchase order for the usual supplier and ask me to approve it."
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {pending ? (
          <p role="status">
            Drafting and checking the workflow. This can take up to a minute…
          </p>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error} Your description is kept so you can try again.
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
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              !availability.data?.available ||
              !(request?.prompt ?? prompt).trim()
            }
            onClick={() => void submit()}
          >
            {pending ? 'Drafting…' : request ? 'Try again' : 'Draft workflow'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const changeLabels = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
} as const;

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
        {generation ? 'From your description' : 'Ask for a change'}
      </h2>
      {generation ? (
        <>
          {generation.outcome === 'partial' ? (
            <Alert tone="warning">
              Luma couldn’t fix every problem in the draft. The remaining
              problems are listed above.
            </Alert>
          ) : null}
          {generation.questions.length ? (
            <div>
              <h3>Questions for you</h3>
              <ul>
                {generation.questions.map((item) => (
                  <li key={`${item.stepId}:${item.field}:${item.question}`}>
                    {item.question}{' '}
                    <span className="authoring-hint">
                      ({item.stepId ?? 'Workflow settings'} ·{' '}
                      {humanize(item.field)})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {generation.assumptions.length ? (
            <div>
              <h3>Assumptions</h3>
              <ul>
                {generation.assumptions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {generation.explanations.length ? (
            <Disclosure variant="plain" className="authoring-advanced">
              <summary>Why each step is there</summary>
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
          <div className="authoring-proposal" aria-label="Proposed change">
            <h3>Proposed change</h3>
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
                      {changeLabels[item.change]}
                    </Badge>{' '}
                    {item.summary}
                  </li>
                ))}
              </ul>
            ) : (
              <p>The instruction didn’t change the draft.</p>
            )}
            {proposal.questions.length ? (
              <p className="authoring-hint">
                Open questions:{' '}
                {proposal.questions.map((item) => item.question).join(' ')}
              </p>
            ) : null}
            {proposal.diagnostics.some((item) => item.severity === 'error') ? (
              <Alert tone="warning">
                The proposed draft still has{' '}
                {
                  proposal.diagnostics.filter(
                    (item) => item.severity === 'error',
                  ).length
                }{' '}
                problem(s) to fix after you accept it.
              </Alert>
            ) : null}
            <div className="workflow-dialog-actions">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void decide(false)}
              >
                Reject
              </Button>
              <Button
                disabled={
                  pending || !saved || proposal.baseRevision !== draft.revision
                }
                onClick={() => void decide(true)}
              >
                Accept change
              </Button>
            </div>
            {proposal.baseRevision !== draft.revision ? (
              <p className="authoring-hint">
                The draft changed after this proposal. Reject it and ask again.
              </p>
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
              What should change?
              <Textarea
                rows={2}
                maxLength={4000}
                disabled={pending || !saved}
                value={instruction}
                placeholder="Also wait an hour before checking the result."
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
              {pending ? 'Proposing…' : 'Propose change'}
            </Button>
            {!saved ? (
              <p className="authoring-hint">
                Wait until your changes are saved.
              </p>
            ) : null}
          </form>
        )
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error} The draft is unchanged.
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
      <summary>Generate from a description</summary>
      <div className="authoring-step-form">
        <label className="authoring-field">
          Describe the calculation
          <Textarea
            rows={2}
            maxLength={4000}
            value={description}
            placeholder="Order enough to reach the target, rounded up to whole boxes of 12."
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
          {pending ? 'Generating…' : 'Suggest code'}
        </Button>
        {error ? (
          <Alert tone="danger" role="alert">
            {error} Your code is unchanged.
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
                Examples to test with:{' '}
                {suggestion.examples
                  .map(
                    (item) => `${item.name} → ${JSON.stringify(item.expected)}`,
                  )
                  .join('; ')}
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
              Use this code
            </Button>
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}
