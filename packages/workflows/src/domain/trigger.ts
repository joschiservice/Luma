import type { PlaybookSnapshot } from './playbook.js';
import type { PublishedWorkflowVersion } from './workflow.js';

/** Validates the supported signals against versioned scope and typed evidence; grants no authority. */
export function validateTriggerSignal(
  version: PublishedWorkflowVersion,
  subject: { kind: string; id: string },
  signal: { kind: string; sourceId: string; occurredAt: string },
  snapshot: PlaybookSnapshot,
  now: number,
): void {
  const trigger = version.applicability.trigger;
  if (subject.kind !== version.applicability.subjectKind || !subject.id.trim())
    throw new Error('Select a resource matching this workflow’s subject type.');
  if (trigger.kind !== signal.kind)
    throw new Error('The signal does not match this version’s trigger.');
  const occurred = Date.parse(signal.occurredAt);
  const captured = Date.parse(snapshot.provenance.capturedAt);
  if (
    !Number.isFinite(occurred) ||
    occurred > now ||
    !Number.isFinite(captured) ||
    captured > now
  )
    throw new Error('Signal and context timestamps must not be in the future.');
  if (trigger.kind === 'schedule') {
    if (Date.parse(trigger.at) <= now)
      throw new Error(
        'This scheduled time has passed. Publish a version with a future time.',
      );

    return;
  }
  if (trigger.kind === 'manual') return;
  if (
    now - occurred >= version.context.maxAgeSeconds * 1000 ||
    snapshot.evidence.observations.some((o) => {
      const at = Date.parse(o.observedAt);

      return (
        !Number.isFinite(at) ||
        at > captured ||
        now - at >= version.context.maxAgeSeconds * 1000
      );
    })
  )
    throw new Error(
      'The trigger evidence expired. Supply a fresh observation.',
    );
  if (
    trigger.kind === 'condition' &&
    snapshot.evidence.facts[trigger.field] !== trigger.equals
  )
    throw new Error(
      'The observed state does not meet this workflow’s condition.',
    );
  if (trigger.kind === 'event' && snapshot.evidence.kind !== trigger.eventType)
    throw new Error('The context kind must match the domain event type.');
}
