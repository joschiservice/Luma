import type { DraftStep, WorkflowDraftContent } from './draft.js';
import type { PlaybookScalar } from './playbook.js';
import type { AuthoringVocabulary } from './vocabulary.js';

/** Turns `belowMinimum` or `purchase_order` into readable words. */
export function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Writes a value as authors read it: yes, no, empty, a number or quoted text. */
export function scalar(value: PlaybookScalar) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null) return 'empty';

  return typeof value === 'string' ? `“${value}”` : String(value);
}

/** Writes seconds in the largest whole unit, for example `5 minute(s)`. */
export function duration(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;

  return `${seconds} second(s)`;
}

const lower = (value: string) =>
  value ? value.charAt(0).toLowerCase() + value.slice(1) : value;

/** Describes one step in business language using the workspace vocabulary where it can. */
export function describeStep(
  step: DraftStep,
  vocabulary: AuthoringVocabulary,
): { title: string; description: string } {
  const title =
    vocabulary.stepKinds.find((item) => item.kind === step.kind)?.label ??
    humanize(step.kind);
  switch (step.kind) {
    case 'read': {
      const source = vocabulary.reads.find(
        (item) => item.source === step.source,
      );

      return {
        title,
        description: `Read ${source ? lower(source.label) : humanize(step.source) || 'data'}${
          Object.keys(step.fields).length
            ? ` (${Object.keys(step.fields).map(humanize).join(', ')})`
            : ''
        }.`,
      };
    }
    case 'condition':
      return {
        title,
        description: `Continue when ${humanize(step.field) || 'a field'} is ${scalar(step.equals)}. Otherwise ${step.onFalse === 'end' ? 'finish' : 'escalate to a person'}.`,
      };
    case 'capability': {
      const action = vocabulary.capabilities.find(
        (item) =>
          item.capability === step.capability &&
          item.version === step.capabilityVersion,
      );

      return {
        title,
        description: `${action?.label ?? (humanize(step.capability) || 'Choose an action')}. ${
          action?.approval ?? 'Action Admission checks policy before it runs.'
        }`,
      };
    }
    case 'approval':
      return {
        title,
        description: `Someone who can approve changes decides on ${step.forStep ? `“${step.forStep}”` : 'the next action'} within ${duration(step.expiresAfterSeconds)}.`,
      };
    case 'human_task':
      return { title, description: step.instructions };
    case 'event_wait':
      return {
        title,
        description: `Wait for ${step.eventType} within ${duration(step.timeoutSeconds)}.`,
      };
    case 'wait':
      return { title, description: `Wait ${duration(step.seconds)}.` };
    case 'verification': {
      const evaluator = vocabulary.evaluators.find(
        (item) => item.version === step.evaluatorVersion,
      );

      return {
        title,
        description: `${evaluator?.label ?? 'Check the result'} of ${step.forStep ? `“${step.forStep}”` : 'the previous action'} within ${duration(step.maxDurationSeconds)}.`,
      };
    }
    case 'escalation':
      return {
        title,
        description: `Hand the run to a person: ${step.reason || 'no reason given'}.`,
      };
    case 'end':
      return {
        title,
        description: `Finish with “${step.outcome || 'an outcome'}”.`,
      };
    case 'code':
      return {
        title,
        description: `Compute ${Object.keys(step.fields).map(humanize).join(', ') || 'a result'} with sandboxed TypeScript${
          step.grants.length
            ? `, then request ${step.grants.map((grant) => `“${grant}”`).join(', ')}`
            : ''
        }.`,
      };
  }
}

function triggerPhrase(content: WorkflowDraftContent) {
  const trigger = content.applicability.trigger;
  switch (trigger.kind) {
    case 'manual':
      return 'When someone starts it';
    case 'event':
      return `When ${humanize(trigger.eventType) || 'an event'} happens`;
    case 'schedule':
      return `At ${trigger.at || 'a scheduled time'}`;
    case 'condition':
      return `When ${humanize(trigger.field) || 'a condition'} is ${scalar(trigger.equals)}`;
    case 'exception':
      return `When a ${humanize(trigger.issueType) || 'new'} issue is detected`;
  }
}

/** Summarizes the whole workflow as one readable sentence. */
export function summarizeDraft(
  content: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
): string {
  const phrases = content.steps
    .filter((step) => step.kind !== 'end')
    .map((step) => {
      const text = describeStep(step, vocabulary).description;
      const first = text.split('. ')[0]!.replace(/\.$/, '');

      return lower(first);
    });
  if (!phrases.length) return `${triggerPhrase(content)}, nothing happens yet.`;
  const last = phrases.pop()!;

  return `${triggerPhrase(content)}, ${phrases.length ? `${phrases.join(', ')}, then ${last}` : last}.`;
}
