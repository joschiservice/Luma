import {
  caseDetailSchema,
  caseEvidencePageSchema,
  caseProgressSchema,
  caseReviewSchema,
  caseTimelineSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';
import { casesKey } from './data';

const api = createWebApiClient();

/** Deduplicates entries by ID, retaining the last value at the first occurrence's position. */
export function uniqueEntries<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/**
 * Loads consistent case, review, and progress revisions plus paginated history; rejects
 * refreshes that span conflicting revisions.
 */
export function progressOptions(
  organizationId: string,
  exceptionId: string,
  pages = 1,
) {
  const options = queryOptions({
    queryKey: [...casesKey(organizationId), 'progress', exceptionId, pages],
    ...privateQueryDefaults,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const request = {
        params: { organizationId, exceptionId },
        fetchOptions: { signal, cache: 'no-store' as const },
      };
      const read = async (
        promise: Promise<{ status: number; body: unknown }>,
      ) => {
        const response = await promise;
        if (response.status !== 200) throw new IdentityError(response.status);

        return response.body;
      };
      const [detail, review, progress] = await Promise.all([
        read(api.exceptions.get(request)).then((body) =>
          caseDetailSchema.parse(body),
        ),
        read(api.caseDesk.review(request)).then((body) =>
          caseReviewSchema.parse(body),
        ),
        read(api.caseDesk.progress(request)).then((body) =>
          caseProgressSchema.parse(body),
        ),
      ]);
      // Separate reads may straddle a transition. Never combine different revisions.
      if (
        detail.revision !== progress.caseRevision ||
        review.caseRevision !== progress.caseRevision ||
        review.diagnosisRevision !== progress.diagnosisRevision ||
        (detail.diagnosis?.revision ?? 0) !== progress.diagnosisRevision
      )
        throw new Error('Case changed during refresh');
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
        detail,
        review,
        progress,
        timeline: uniqueEntries(timeline),
        evidence: uniqueEntries(evidence),
        hasMore: Boolean(timelineCursor || evidenceCursor),
      };
    },
  });

  return queryOptions({
    ...options,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === organizationId &&
      previousQuery.queryKey[5] === exceptionId
        ? previous
        : undefined,
  });
}
