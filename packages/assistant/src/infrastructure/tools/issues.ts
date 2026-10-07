import type { CaseService } from '@luma/exceptions';
import { IdentityError } from '@luma/identity';
import { z } from 'zod';

import { defineTool } from '../../application/tools.js';
import { citationMarker, clip } from '../../domain/answer.js';
import {
  humanize,
  issueReference,
  members,
  parser,
  summary,
} from './references.js';

type Issue = Awaited<ReturnType<CaseService['list']>>['items'][number];

type IssueQuery = Parameters<CaseService['list']>[1];

const views = members<IssueQuery['view']>({
  needs_you: true,
  active: true,
  history: true,
});
const classes = members<NonNullable<IssueQuery['class']>>({
  sync_failure: true,
  stuck_fulfillment: true,
  inventory_mismatch: true,
  workflow_failure: true,
});
const severities = members<NonNullable<IssueQuery['severity']>>({
  high: true,
  medium: true,
});
const states = members<NonNullable<IssueQuery['state']>>({
  detected: true,
  diagnosed: true,
  proposed: true,
  awaiting_approval: true,
  allowed: true,
  executing: true,
  verifying: true,
  resolved: true,
  failed: true,
  escalated: true,
});

const searchInput = z
  .object({
    view: z.enum(views).default('needs_you'),
    class: z.enum(classes).optional(),
    severity: z.enum(severities).optional(),
    state: z.enum(states).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

function issueRow(issue: Issue) {
  return {
    cite: citationMarker('issue', issue.id),
    class: issue.class,
    summary: clip(issue.summary, 300),
    state: issue.state,
    severity: issue.severity,
    needsYou: issue.attention.required,
    attentionReason: issue.attention.reason,
    subject: { kind: issue.subject.kind, id: issue.subject.id },
    detectedAt: issue.detectedAt,
    lastActivityAt: issue.lastActivityAt,
    evidence: issue.freshness,
    diagnosis: issue.diagnosisStatus,
    resolution: issue.resolution,
  };
}

const reference = (issue: Issue) =>
  issueReference({ ...issue, observedAt: issue.lastActivityAt });

/** Lists issues (cases) as the Issues inbox shows them. */
export function searchIssuesTool(cases: Pick<CaseService, 'list'>) {
  return defineTool(parser(searchInput), {
    name: 'search_issues',
    label: 'Search issues',
    reads: 'issue',
    permission: 'issues.read',
    description:
      'List operational issues Luma detected, as in the Issues inbox. Views: `needs_you` (waiting for a person, for example an approval), `active` (all unresolved), `history` (resolved or closed). Filter by class (sync failure, stuck fulfillment, inventory mismatch, workflow failure), severity or state. `evidence` says whether the issue’s evidence is fresh or stale; `resolution` is `verified` only after an independent check.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: views },
        class: { type: 'string', enum: classes },
        severity: { type: 'string', enum: severities },
        state: { type: 'string', enum: states },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        cursor: { type: 'string' },
      },
    },
    describe: (input) =>
      summary('Searched issues', [
        humanize(input.view),
        input.class && humanize(input.class),
        input.severity && `${input.severity} severity`,
        input.state && humanize(input.state),
        input.cursor && 'next page',
      ]),
    async run(context, input) {
      const list = await cases.list(context, input);

      return {
        data: {
          totalMatches: list.totalCount,
          items: list.items.map(issueRow),
          nextCursor: list.nextCursor,
          // `unobserved` means no connection has been read yet, so an empty list proves nothing.
          coverage: list.coverage,
        },
        records: list.items.map(reference),
      };
    },
  });
}

const getInput = z.object({ issueId: z.string().uuid() }).strict();

/** Reads one issue with its diagnosis: facts, likely causes and suggested next steps. */
export function getIssueTool(cases: Pick<CaseService, 'get'>) {
  return defineTool(parser(getInput), {
    name: 'get_issue',
    label: 'Read an issue',
    reads: 'issue',
    permission: 'issues.read',
    description:
      'Read one issue by its Luma ID: what was detected, its state, and Luma’s diagnosis with facts, likely causes, impact and suggested next steps. A diagnosis is Luma’s conclusion, not a source fact.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issueId'],
      properties: { issueId: { type: 'string', format: 'uuid' } },
    },
    describe: () => 'Read issue details',
    async run(context, input) {
      const issue = await cases.get(context, input.issueId);
      if (!issue) throw new IdentityError(404, 'NOT_FOUND', 'Issue not found');
      const diagnosis = issue.diagnosis;

      return {
        data: {
          issue: issueRow(issue),
          diagnosis: diagnosis
            ? {
                status: diagnosis.status,
                summary: clip(diagnosis.summary, 600),
                facts: diagnosis.facts.slice(0, 8),
                likelyCauses: diagnosis.hypotheses.slice(0, 5),
                impact: {
                  observed: diagnosis.impact.observed.slice(0, 5),
                  exposedQuantity: diagnosis.impact.exposedQuantity,
                  unit: diagnosis.impact.unit,
                },
                nextSteps: diagnosis.nextSteps.slice(0, 5),
                generatedAt: diagnosis.provenance.generatedAt,
              }
            : null,
        },
        records: [reference(issue)],
      };
    },
  });
}
