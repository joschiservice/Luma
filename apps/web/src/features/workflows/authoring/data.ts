import type {
  AcceptProposal,
  CodeStepSuggestionRequest,
  CreateWorkflowDraft,
  DescribeWorkflow,
  RefineWorkflowDraft,
  SaveDraftTests,
  SaveWorkflowDraft,
  StartDraftTest,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { privateQueryDefaults } from '../../../lib/private-query';
import { workflowApi as api, workflowsKey } from '../data';
import { localizeVocabulary } from './vocabulary-text';

/** Cache prefix for one workspace's drafts. */
export const draftsKey = (organizationId: string) =>
  [...workflowsKey(organizationId), 'drafts'] as const;

/** Lists templates with their requirements and readiness in this workspace. */
export const templatesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'templates'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) =>
      (
        await api.workflowDrafts.templates(
          { params: { organizationId } },
          { signal },
        )
      ).items,
  });

/** Adds a template's reviewed version to the workspace. Repeating it is safe. */
export async function installTemplate(
  organizationId: string,
  templateId: string,
) {
  return api.workflowDrafts.installTemplate({
    params: { organizationId, templateId },
    body: {},
  });
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
    queryFn: ({ signal }) =>
      api.workflowDrafts.vocabulary({ params: { organizationId } }, { signal }),
    select: localizeVocabulary,
  });

/** Lists open drafts, most recently changed first. */
export const draftsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: draftsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) =>
      (
        await api.workflowDrafts.list(
          { params: { organizationId } },
          { signal },
        )
      ).items,
  });

/** Reads one draft at its latest saved revision. */
export const draftOptions = (organizationId: string, draftId: string) =>
  queryOptions({
    queryKey: [...draftsKey(organizationId), draftId],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflowDrafts.get(
        { params: { organizationId, draftId } },
        { signal },
      ),
  });

/** Starts a draft. Reuse the same ID and body after an uncertain response. */
export async function createDraft(
  organizationId: string,
  body: CreateWorkflowDraft,
) {
  return api.workflowDrafts.create({
    params: { organizationId },
    body,
  });
}

/** Saves against the loaded revision. A 409 means someone else saved first. */
export async function saveDraft(
  organizationId: string,
  draftId: string,
  body: SaveWorkflowDraft,
) {
  return api.workflowDrafts.save({
    params: { organizationId, draftId },
    body,
  });
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
  return api.workflowDrafts.validate(
    {
      params: { organizationId },
      body,
    },
    signal ? { signal } : {},
  );
}

/** Publishes the reviewed revision as a new immutable version. It does not activate it. */
export async function publishDraft(
  organizationId: string,
  draftId: string,
  body: { revision: number; notes?: string },
) {
  return api.workflowDrafts.publish({
    params: { organizationId, draftId },
    body,
  });
}

/** Discards an unpublished draft. Repeating it is safe. */
export async function discardDraft(
  organizationId: string,
  draftId: string,
  revision: number,
) {
  return api.workflowDrafts.discard({
    params: { organizationId, draftId },
    body: { revision },
  });
}

/** Reads saved test cases and their latest results on the current revision. */
export const draftTestsOptions = (organizationId: string, draftId: string) =>
  queryOptions({
    queryKey: [...draftsKey(organizationId), draftId, 'tests'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.draftTests.list({ params: { organizationId, draftId } }, { signal }),
  });

/** Replaces saved test cases against the loaded tests revision. */
export async function saveDraftTests(
  organizationId: string,
  draftId: string,
  body: SaveDraftTests,
) {
  return api.draftTests.save({
    params: { organizationId, draftId },
    body,
  });
}

/** Runs every saved case that hasn't run on this draft revision. Repeating it is safe. */
export async function runDraftTests(
  organizationId: string,
  draftId: string,
  revision: number,
) {
  return api.draftTests.runAll({
    params: { organizationId, draftId },
    body: { revision },
  });
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
    queryFn: ({ signal }) =>
      api.draftTests.examples(
        { params: { organizationId, draftId } },
        { signal },
      ),
  });

/** Starts one test run. Reuse the same ID and body after an uncertain response. */
export async function startDraftTest(
  organizationId: string,
  draftId: string,
  body: StartDraftTest,
) {
  return api.draftTests.start({
    params: { organizationId, draftId },
    body,
  });
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
    queryFn: ({ signal }) =>
      api.draftTests.get(
        { params: { organizationId, draftId, runId } },
        { signal },
      ),
  });

/** Cancels a running test. Cancelling again is safe. */
export async function cancelDraftTest(
  organizationId: string,
  draftId: string,
  runId: string,
) {
  return api.draftTests.cancel({
    params: { organizationId, draftId, runId },
    body: {},
  });
}

/** Reads whether describing workflows is available here, and why not. */
export const generationAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'generation'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflowGeneration.availability(
        { params: { organizationId } },
        { signal },
      ),
  });

/** Drafts a workflow from a description. Reuse the same IDs and body after an uncertain response. */
export async function describeWorkflow(
  organizationId: string,
  body: DescribeWorkflow,
  signal?: AbortSignal,
) {
  return api.workflowGeneration.describe(
    {
      params: { organizationId },
      body,
    },
    signal ? { signal } : {},
  );
}

/** Proposes a change to the loaded revision. Nothing is applied until it is accepted. */
export async function refineDraft(
  organizationId: string,
  draftId: string,
  body: RefineWorkflowDraft,
  signal?: AbortSignal,
) {
  return api.workflowGeneration.refine(
    {
      params: { organizationId, draftId },
      body,
    },
    signal ? { signal } : {},
  );
}

/** Applies a proposal to the revision it was made for. */
export async function acceptProposal(
  organizationId: string,
  draftId: string,
  proposalId: string,
  body: AcceptProposal,
) {
  return api.workflowGeneration.accept({
    params: { organizationId, draftId, proposalId },
    body,
  });
}

/** Records that a proposal was rejected. The draft is unchanged. */
export async function rejectProposal(
  organizationId: string,
  draftId: string,
  proposalId: string,
) {
  const { proposal } = await api.workflowGeneration.reject({
    params: { organizationId, draftId, proposalId },
    body: {},
  });

  return proposal;
}

/** Suggests Code Step source for a described calculation. Nothing is saved. */
export async function suggestCodeStep(
  organizationId: string,
  draftId: string,
  body: CodeStepSuggestionRequest,
  signal?: AbortSignal,
) {
  return api.workflowGeneration.codeStep(
    {
      params: { organizationId, draftId },
      body,
    },
    signal ? { signal } : {},
  );
}
