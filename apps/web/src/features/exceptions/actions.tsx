import { CaseShadow } from '../shadow/case';
import type { CaseObservation } from './observation';
import { CaseResolution } from './resolution';

/** Shares resolution and Shadow controls between the issue panel and full-page view. */
export function IssueActions({
  organizationId,
  exceptionId,
  observation,
  connectionLabels,
  initialWorkflow,
}: {
  organizationId: string;
  exceptionId: string;
  observation: CaseObservation;
  connectionLabels: Record<string, string>;
  initialWorkflow?: string | undefined;
}) {
  return (
    <>
      <section tabIndex={-1} aria-label="Resolution review">
        <CaseResolution
          organizationId={organizationId}
          exceptionId={exceptionId}
          observation={observation}
          connectionLabels={connectionLabels}
        />
      </section>
      <CaseShadow
        key={`${exceptionId}:${initialWorkflow ?? ''}`}
        organizationId={organizationId}
        exceptionId={exceptionId}
        initialWorkflow={initialWorkflow}
        disabled={
          !observation.confirmed ||
          observation.snapshot.isError ||
          observation.offline
        }
      />
    </>
  );
}
