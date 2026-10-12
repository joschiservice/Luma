import type { DecisionOwner } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** Reviews and answers the authoritative task contract from Needs you. */
export function HumanTaskReview({
  organizationId,
  owner,
  onChange,
}: {
  organizationId: string;
  owner: Extract<DecisionOwner, { kind: 'human_task' }>;
  onChange: () => Promise<void>;
}) {
  const params = {
    organizationId,
    definitionId: owner.definitionId,
    runId: owner.runId,
    stepId: owner.stepId,
  };
  const task = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      organizationId,
      'human-task',
      owner.runId,
      owner.stepId,
    ],
    queryFn: ({ signal }) => api.workflows.humanTask({ params }, { signal }),
    refetchInterval: 5000,
  });
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const id = useId();
  const answer = useMutation({
    mutationFn: () => {
      if (!task.data) throw new Error(m.authoring_coordination_unavailable());

      return api.workflows.answerHumanTask({
        params,
        body: {
          choice,
          note,
          evidence: { kind: task.data.evidence, value: evidence },
        },
      });
    },
    onSuccess: async () => {
      await task.refetch();
      await onChange();
    },
  });
  if (task.isPending)
    return <p role="status">{m.authoring_coordination_loading()}</p>;
  if (task.isError || !task.data)
    return <p role="alert">{m.authoring_coordination_unavailable()}</p>;
  if (task.data.state === 'answered')
    return <p role="status">{m.authoring_coordination_answered()}</p>;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        answer.mutate();
      }}
    >
      <p>{task.data.instructions}</p>
      <p>
        {m.authoring_coordination_due_date()}{' '}
        <WorkspaceDate value={task.data.dueAt} />
      </p>
      {task.data.escalatedAt ? (
        <p role="status">{m.authoring_coordination_overdue()}</p>
      ) : null}
      <label htmlFor={`${id}-choice`}>
        {m.authoring_coordination_answer()}
      </label>
      <Select
        id={`${id}-choice`}
        value={choice}
        onValueChange={(value) => setChoice(value ?? '')}
        options={task.data.choices.map((value) => ({ value, label: value }))}
        disabled={answer.isPending}
      />
      <label htmlFor={`${id}-evidence`}>
        {m.authoring_coordination_evidence()}
      </label>
      <Input
        id={`${id}-evidence`}
        value={evidence}
        onChange={(event) => setEvidence(event.target.value)}
        maxLength={2000}
        required
        disabled={answer.isPending}
      />
      <label htmlFor={`${id}-note`}>{m.authoring_coordination_note()}</label>
      <Textarea
        id={`${id}-note`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={2000}
        disabled={answer.isPending}
      />
      {answer.isError ? <p role="alert">{answer.error.message}</p> : null}
      <Button
        type="submit"
        disabled={!choice || !evidence.trim() || answer.isPending}
      >
        {m.authoring_coordination_submit()}
      </Button>
    </form>
  );
}
