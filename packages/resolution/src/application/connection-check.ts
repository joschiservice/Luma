import type {
  CaseWorkflowAdapter,
  ProcessWorkflowVersion,
} from '@luma/workflows';

import { accessErrorCodes } from '../domain/connection-check.js';
import type { DetectionSources } from './detection-monitor.js';

/**
 * Builds the connection check over the sync state that detection reads. It only reads stored
 * state and never changes a connected system, so it has no action or approval.
 */
export function createConnectionCheckWorkflow(deps: {
  version: ProcessWorkflowVersion;
  sources: Pick<DetectionSources, 'streams'>;
  now(): Date;
}): CaseWorkflowAdapter {
  return {
    version: deps.version,
    template: {
      trigger: 'When detection confirms that a connection’s reads keep failing',
      steps: [
        'Read the failing sync stream',
        'Hand lost or revoked access to a person straight away',
        'Wait 15 minutes, then check the stream again',
        'Hand the case over when reads still fail',
      ],
      success:
        'Reads recover on their own, or a person gets the case with the reason. Detection closes the case after a complete read.',
    },
    stepCopy: {
      failure: {
        title: 'Read the sync stream',
        description:
          'Reads the stream’s recorded failures and whether the connection is still active.',
      },
      found: {
        title: 'Find the stream',
        description:
          'Hands over when the failing stream is no longer recorded.',
      },
      access: {
        title: 'Check access',
        description:
          'Hands over straight away when the provider rejected Luma’s credentials or the connection lost access.',
      },
      'still-failing': {
        title: 'Check for recovery',
        description: 'Stops when reads already recovered.',
      },
      grace: {
        title: 'Give the provider time',
        description: 'Waits 15 minutes before checking again.',
      },
      recheck: {
        title: 'Read the sync stream again',
        description: 'Reads the stream’s failures after the wait.',
      },
      recovered: {
        title: 'Check again',
        description: 'Hands the case over when reads still fail.',
      },
      done: {
        title: 'Finish',
        description:
          'Records the recovery. Detection closes the case after a complete read.',
      },
    },
    requirements: async () => [],
    async subject(_context, signal) {
      return signal.issueType === 'sync_failure'
        ? { kind: 'connection', id: signal.subject.id }
        : null;
    },
    async read(context, run) {
      const capability = run.signal.subject.scope[0];
      const stream = (await deps.sources.streams(context)).find(
        (item) =>
          item.connectionId === run.signal.subject.id &&
          item.capability === capability,
      );
      const observedAt = deps.now().toISOString();
      if (!stream)
        return {
          values: {
            ready: false,
            accessLost: false,
            failing: false,
            errorCode: '',
          },
          evidenceRefs: [run.signal.id],
          observedAt,
        };
      const failing = stream.attempts > 0 && !!stream.failingSince;

      return {
        values: {
          ready: true,
          accessLost:
            !stream.active ||
            (failing && accessErrorCodes.includes(stream.errorCode ?? '')),
          failing,
          errorCode: stream.errorCode ?? '',
        },
        evidenceRefs: [stream.id],
        observedAt,
      };
    },
    action: async () => {
      throw new Error('The connection check changes nothing');
    },
    verify: async () => {
      throw new Error('The connection check changes nothing');
    },
  };
}
