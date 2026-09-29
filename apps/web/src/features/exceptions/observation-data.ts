import {
  caseEvidencePageSchema,
  caseProgressSchema,
  caseReviewSchema,
  caseTimelineSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';
import { caseOptions, casesKey } from './data';

const api = createWebApiClient();

/** Deduplicates entries by ID, retaining the last value at the first occurrence's position. */
function uniqueEntries<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

async function read(promise: Promise<{ status: number; body: unknown }>) {
  const response = await promise;
  if (response.status !== 200)
    throw new IdentityError(response.status, response.body);

  return response.body;
}

/** Loads case, review and progress together; rejects conflicting case or diagnosis revisions. */
export function observationOptions(
  organizationId: string,
  exceptionId: string,
) {
  const detail = caseOptions(organizationId, exceptionId);

  return queryOptions({
    queryKey: [...casesKey(organizationId), 'observation', exceptionId],
    ...privateQueryDefaults,
    enabled: Boolean(exceptionId),
    refetchOnWindowFocus: 'always',
    queryFn: async (context) => {
      const request = {
        params: { organizationId, exceptionId },
        fetchOptions: { signal: context.signal, cache: 'no-store' as const },
      };
      const [item, review, progress] = await Promise.all([
        detail.queryFn!(context),
        read(api.caseDesk.review(request)).then((body) =>
          caseReviewSchema.parse(body),
        ),
        read(api.caseDesk.progress(request)).then((body) =>
          caseProgressSchema.parse(body),
        ),
      ]);
      if (
        item.revision !== progress.caseRevision ||
        review.caseRevision !== progress.caseRevision ||
        review.diagnosisRevision !== progress.diagnosisRevision ||
        (item.diagnosis?.revision ?? 0) !== progress.diagnosisRevision
      )
        throw new Error('Case changed during refresh');

      return { detail: item, review, progress };
    },
  });
}

/** Loads retained history from the first page, independently of current case observation. */
export function historyOptions(
  organizationId: string,
  exceptionId: string,
  pages = 1,
) {
  return queryOptions({
    queryKey: [...casesKey(organizationId), 'history', exceptionId, pages],
    ...privateQueryDefaults,
    enabled: Boolean(exceptionId),
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const request = {
        params: { organizationId, exceptionId },
        fetchOptions: { signal, cache: 'no-store' as const },
      };
      const timeline: import('@luma/api-contract').CaseTimelinePage['items'] =
        [];
      const evidence: import('@luma/api-contract').CaseEvidencePage['items'] =
        [];
      let timelineCursor: string | null | undefined;
      let evidenceCursor: string | null | undefined;
      for (let page = 0; page < pages; page++) {
        await Promise.all([
          timelineCursor !== null
            ? read(
                api.caseDesk.timeline({
                  ...request,
                  query: {
                    limit: 100,
                    ...(timelineCursor ? { cursor: timelineCursor } : {}),
                  },
                }),
              ).then((body) => {
                const result = caseTimelineSchema.parse(body);
                timeline.push(...result.items);
                timelineCursor = result.nextCursor;
              })
            : undefined,
          evidenceCursor !== null
            ? read(
                api.exceptions.evidence({
                  ...request,
                  query: {
                    limit: 100,
                    ...(evidenceCursor ? { cursor: evidenceCursor } : {}),
                  },
                }),
              ).then((body) => {
                const result = caseEvidencePageSchema.parse(body);
                evidence.push(...result.items);
                evidenceCursor = result.nextCursor;
              })
            : undefined,
        ]);
        if (!timelineCursor && !evidenceCursor) break;
      }

      return {
        timeline: uniqueEntries(timeline),
        evidence: uniqueEntries(evidence),
        hasMore: Boolean(timelineCursor || evidenceCursor),
        hasMoreTimeline: Boolean(timelineCursor),
        hasMoreEvidence: Boolean(evidenceCursor),
      };
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === organizationId &&
      previousQuery.queryKey[5] === exceptionId
        ? previous
        : undefined,
  });
}
