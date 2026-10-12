import type {
  HumanTaskAnswer,
  ProcessStep,
  ProcessStepOutput,
  TaskAssignee,
} from './process.js';

/** Persisted handoff; deadlines reassign open tasks and never expire a submitted answer. */
export interface HumanTask {
  runId: string;
  stepId: string;
  definitionId: string;
  subject: { kind: string; id: string };
  assignee: TaskAssignee;
  escalationTarget: TaskAssignee;
  instructions: string;
  choices: string[];
  evidence: 'text' | 'link' | 'record';
  dueAt: string;
  createdAt: string;
  escalatedAt: string | null;
  state: 'open' | 'answered' | 'cancelled';
  answer: (HumanTaskAnswer & { actorId: string; answeredAt: string }) | null;
}

/** An immutable delivery, correlated within one tenant. Replays must use the original body. */
export interface WorkflowEvent {
  sourceId: string;
  eventType: string;
  correlationKey: string;
  occurredAt: string;
  values: ProcessStepOutput['values'];
  evidenceRefs: string[];
}

/** Validates a response against the published task contract before storing any answer. */
export function validateHumanTaskAnswer(
  task: Pick<HumanTask, 'choices' | 'evidence'>,
  answer: HumanTaskAnswer,
): void {
  if (
    !task.choices.includes(answer.choice) ||
    answer.evidence.kind !== task.evidence ||
    !answer.evidence.value.trim() ||
    answer.evidence.value.length > 2000 ||
    (answer.note?.length ?? 0) > 2000
  )
    throw new Error('The answer does not match this task.');
  if (answer.evidence.kind === 'link') {
    const url = new URL(answer.evidence.value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Use an HTTP or HTTPS evidence link.');
  }
  if (
    answer.evidence.kind === 'record' &&
    !/^[a-z][a-z_]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      answer.evidence.value,
    )
  )
    throw new Error('Use a typed record reference.');
}

/** Event payloads must match the wait's exact typed fields and retain independent evidence. */
export function matchesEventFields(
  step: Extract<ProcessStep, { kind: 'event_wait' }>,
  event: WorkflowEvent,
): boolean {
  return (
    event.evidenceRefs.length > 0 &&
    Object.keys(event.values).length === Object.keys(step.fields).length &&
    Object.entries(step.fields).every(
      ([key, type]) =>
        Object.hasOwn(event.values, key) &&
        (event.values[key] === null ? 'null' : typeof event.values[key]) ===
          type,
    )
  );
}
