import {
  acceptedProposalSchema,
  type AcceptProposal,
  authoringVocabularySchema,
  type CodeStepSuggestionRequest,
  codeStepSuggestionSchema,
  type CreateWorkflowDraft,
  type DescribeWorkflow,
  draftProposalSchema,
  draftTestExamplesSchema,
  draftTestRunSchema,
  draftTestSummarySchema,
  draftValidationSchema,
  generatedDraftSchema,
  generationAvailabilitySchema,
  publishedDraftSchema,
  type RefineWorkflowDraft,
  type SaveDraftTests,
  type SaveWorkflowDraft,
  type StartDraftTest,
  type WorkflowDraftContent,
  workflowDraftSchema,
  workflowTemplateSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../../lib/api-client';
import { privateQueryDefaults } from '../../../lib/private-query';
import { workflowFailure, workflowsKey } from '../data';
import { localizeVocabulary } from './vocabulary-text';

const api = createWebApiClient();

/** Cache prefix for one workspace's drafts. */
export const draftsKey = (organizationId: string) =>
  [...workflowsKey(organizationId), 'drafts'] as const;

/** Lists templates with their requirements and readiness in this workspace. */
export const templatesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'templates'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflowDrafts.templates({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return result.body.items.map((item) =>
        workflowTemplateSchema.parse(item),
      );
    },
  });

/** Adds a template's reviewed version to the workspace. Repeating it is safe. */
export async function installTemplate(
  organizationId: string,
  templateId: string,
) {
  const result = await api.workflowDrafts.installTemplate({
    params: { organizationId, templateId },
    body: {},
  });
  if (result.status !== 200) return workflowFailure(result);

  return workflowTemplateSchema.parse(result.body);
}

/**
 * Reads what authors can use here, including entries that cannot run and why. Known triggers,
 * step types and subjects are shown in the interface language.
 */
export const vocabularyOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'vocabulary'],
    ...privateQueryDefaults,
    staleTime: 60_000,
    gcTime: 300_000,
    queryFn: async ({ signal }) => {
      const result = await api.workflowDrafts.vocabulary({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return authoringVocabularySchema.parse(result.body);
    },
    select: localizeVocabulary,
  });

/** Lists open drafts, most recently changed first. */
export const draftsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: draftsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflowDrafts.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return result.body.items.map((item) => workflowDraftSchema.parse(item));
    },
  });

/** Reads one draft at its latest saved revision. */
export const draftOptions = (organizationId: string, draftId: string) =>
  queryOptions({
    queryKey: [...draftsKey(organizationId), draftId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflowDrafts.get({
        params: { organizationId, draftId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return workflowDraftSchema.parse(result.body);
    },
  });

/** Starts a draft. Reuse the same ID and body after an uncertain response. */
export async function createDraft(
  organizationId: string,
  body: CreateWorkflowDraft,
) {
  const result = await api.workflowDrafts.create({
    params: { organizationId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return workflowDraftSchema.parse(result.body);
}

/** Saves against the loaded revision. A 409 means someone else saved first. */
export async function saveDraft(
  organizationId: string,
  draftId: string,
  body: SaveWorkflowDraft,
) {
  const result = await api.workflowDrafts.save({
    params: { organizationId, draftId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return workflowDraftSchema.parse(result.body);
}

/** Checks content, code or a saved draft without changing anything. */
export async function validateDraft(
  organizationId: string,
  body: {
    draftId?: string;
    content?: WorkflowDraftContent;
    code?: string;
  },
  signal?: AbortSignal,
) {
  const result = await api.workflowDrafts.validate({
    params: { organizationId },
    body: body as { draftId?: string; content?: Record<string, unknown> },
    ...(signal ? { fetchOptions: { signal } } : {}),
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftValidationSchema.parse(result.body);
}

/** Publishes the reviewed revision as a new immutable version. It does not activate it. */
export async function publishDraft(
  organizationId: string,
  draftId: string,
  body: { revision: number; notes?: string },
) {
  const result = await api.workflowDrafts.publish({
    params: { organizationId, draftId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return publishedDraftSchema.parse(result.body);
}

/** Discards an unpublished draft. Repeating it is safe. */
export async function discardDraft(
  organizationId: string,
  draftId: string,
  revision: number,
) {
  const result = await api.workflowDrafts.discard({
    params: { organizationId, draftId },
    body: { revision },
  });
  if (result.status !== 200) return workflowFailure(result);

  return result.body;
}

/** Reads saved test cases and their latest results on the current revision. */
export const draftTestsOptions = (organizationId: string, draftId: string) =>
  queryOptions({
    queryKey: [...draftsKey(organizationId), draftId, 'tests'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.draftTests.list({
        params: { organizationId, draftId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return draftTestSummarySchema.parse(result.body);
    },
  });

/** Replaces saved test cases against the loaded tests revision. */
export async function saveDraftTests(
  organizationId: string,
  draftId: string,
  body: SaveDraftTests,
) {
  const result = await api.draftTests.save({
    params: { organizationId, draftId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftTestSummarySchema.parse(result.body);
}

/** Runs every saved case that hasn't run on this draft revision. Repeating it is safe. */
export async function runDraftTests(
  organizationId: string,
  draftId: string,
  revision: number,
) {
  const result = await api.draftTests.runAll({
    params: { organizationId, draftId },
    body: { revision },
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftTestSummarySchema.parse(result.body);
}

/** Suggests example data from declared fields, recent runs and scenarios. */
export const draftTestExamplesOptions = (
  organizationId: string,
  draftId: string,
  revision: number,
) =>
  queryOptions({
    queryKey: [
      ...draftsKey(organizationId),
      draftId,
      'test-examples',
      revision,
    ],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.draftTests.examples({
        params: { organizationId, draftId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return draftTestExamplesSchema.parse(result.body);
    },
  });

/** Starts one test run. Reuse the same ID and body after an uncertain response. */
export async function startDraftTest(
  organizationId: string,
  draftId: string,
  body: StartDraftTest,
) {
  const result = await api.draftTests.start({
    params: { organizationId, draftId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftTestRunSchema.parse(result.body);
}

/** Reads one test run. Poll it while its state is `running`. */
export const draftTestRunOptions = (
  organizationId: string,
  draftId: string,
  runId: string,
) =>
  queryOptions({
    queryKey: [...draftsKey(organizationId), draftId, 'test-runs', runId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.draftTests.get({
        params: { organizationId, draftId, runId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return draftTestRunSchema.parse(result.body);
    },
  });

/** Cancels a running test. Cancelling again is safe. */
export async function cancelDraftTest(
  organizationId: string,
  draftId: string,
  runId: string,
) {
  const result = await api.draftTests.cancel({
    params: { organizationId, draftId, runId },
    body: {},
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftTestRunSchema.parse(result.body);
}

/** Reads whether describing workflows is available here, and why not. */
export const generationAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'generation'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflowGeneration.availability({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return workflowFailure(result);

      return generationAvailabilitySchema.parse(result.body);
    },
  });

/** Drafts a workflow from a description. Reuse the same IDs and body after an uncertain response. */
export async function describeWorkflow(
  organizationId: string,
  body: DescribeWorkflow,
  signal?: AbortSignal,
) {
  const result = await api.workflowGeneration.describe({
    params: { organizationId },
    body,
    ...(signal ? { fetchOptions: { signal } } : {}),
  });
  if (result.status !== 200) return workflowFailure(result);

  return generatedDraftSchema.parse(result.body);
}

/** Proposes a change to the loaded revision. Nothing is applied until it is accepted. */
export async function refineDraft(
  organizationId: string,
  draftId: string,
  body: RefineWorkflowDraft,
  signal?: AbortSignal,
) {
  const result = await api.workflowGeneration.refine({
    params: { organizationId, draftId },
    body,
    ...(signal ? { fetchOptions: { signal } } : {}),
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftProposalSchema.parse(result.body);
}

/** Applies a proposal to the revision it was made for. */
export async function acceptProposal(
  organizationId: string,
  draftId: string,
  proposalId: string,
  body: AcceptProposal,
) {
  const result = await api.workflowGeneration.accept({
    params: { organizationId, draftId, proposalId },
    body,
  });
  if (result.status !== 200) return workflowFailure(result);

  return acceptedProposalSchema.parse(result.body);
}

/** Records that a proposal was rejected. The draft is unchanged. */
export async function rejectProposal(
  organizationId: string,
  draftId: string,
  proposalId: string,
) {
  const result = await api.workflowGeneration.reject({
    params: { organizationId, draftId, proposalId },
    body: {},
  });
  if (result.status !== 200) return workflowFailure(result);

  return draftProposalSchema.parse(result.body.proposal);
}

/** Suggests Code Step source for a described calculation. Nothing is saved. */
export async function suggestCodeStep(
  organizationId: string,
  draftId: string,
  body: CodeStepSuggestionRequest,
  signal?: AbortSignal,
) {
  const result = await api.workflowGeneration.codeStep({
    params: { organizationId, draftId },
    body,
    ...(signal ? { fetchOptions: { signal } } : {}),
  });
  if (result.status !== 200) return workflowFailure(result);

  return codeStepSuggestionSchema.parse(result.body);
}
