import type { Permission, TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict } from '@luma/platform';

import {
  type AuthoringMode,
  compareVersions,
  diagnostic,
  type DraftOrigin,
  nextVersion,
  type WorkflowDiagnostic,
  type WorkflowDraft,
  type WorkflowDraftContent,
} from '../domain/draft.js';
import { describeStep, summarizeDraft } from '../domain/draft-presentation.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import {
  type AuthoringVocabulary,
  checkVocabulary,
  type CodeStepSupport,
  executionBlockers,
  mergeVocabulary,
  stepScopes,
  type VocabularyContribution,
} from '../domain/vocabulary.js';
import type { PublishedWorkflowVersion } from '../domain/workflow.js';
import {
  parseWorkflowSource,
  printWorkflowSource,
  WorkflowCodeError,
} from '../domain/workflow-code.js';

/** A draft with the request fingerprints used to make create and save retries safe. */
export interface StoredWorkflowDraft extends WorkflowDraft {
  createDigest: string;
  lastSave: { id: string; digest: string } | null;
}

/** An audit record for draft lifecycle changes, written in the same transaction as the change. */
export interface WorkflowAuditEntry {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  actor: { kind: 'user'; id: string };
  correlationId: string;
  proposalId: string;
  actionHash: string;
  evidenceRefs: string[];
  details: Record<string, string>;
}

/** Transactional draft operations. `lock` holds the draft row until the transaction ends. */
interface WorkflowDraftTransaction {
  lock(id: string): Promise<StoredWorkflowDraft | null>;
  /** Inserts a new draft. Returns false when the ID already exists. */
  insert(draft: StoredWorkflowDraft): Promise<boolean>;
  update(draft: StoredWorkflowDraft): Promise<void>;
  /** Stores an immutable version in the workflow catalog; conflicting content fails. */
  publish(version: ProcessWorkflowVersion): Promise<void>;
  audit(entry: WorkflowAuditEntry): Promise<void>;
}

/** Tenant-isolated draft persistence. */
export interface WorkflowDraftStore {
  /** Lists open drafts, most recently changed first. */
  list(context: TenantContext): Promise<StoredWorkflowDraft[]>;
  get(context: TenantContext, id: string): Promise<StoredWorkflowDraft | null>;
  transaction<T>(
    context: TenantContext,
    operation: (tx: WorkflowDraftTransaction) => Promise<T>,
  ): Promise<T>;
}

/** An installed adapter that contributes authoring entries for this workspace. */
export interface VocabularySource {
  vocabulary(context: TenantContext): Promise<VocabularyContribution>;
}

/** Where a new draft starts. */
export type DraftStart =
  | { kind: 'blank'; name?: string | undefined }
  | { kind: 'content'; content: unknown }
  | { kind: 'template'; templateId: string }
  | { kind: 'version'; definitionId: string; version: string };

/** Result of checking draft content. Validation never changes stored data. */
export interface DraftValidation {
  revision: number | null;
  content: WorkflowDraftContent | null;
  publishable: boolean;
  diagnostics: WorkflowDiagnostic[];
  steps: {
    index: number;
    id: string;
    kind: WorkflowDraftContent['steps'][number]['kind'];
    title: string;
    description: string;
    scope: ReturnType<typeof stepScopes>[number];
  }[];
  summary: string | null;
  /** Canonical code view of the content. */
  printed: string | null;
  publishedVersions: string[];
  suggestedVersion: string;
}

type Check = (
  input: unknown,
  provenance: ProcessWorkflowVersion['provenance'],
) => {
  content: WorkflowDraftContent | null;
  version: ProcessWorkflowVersion | null;
  diagnostics: WorkflowDiagnostic[];
};

const maxContentBytes = 262_144;

// Workflow pages use these path segments, so no definition may take them.
const pageNames = new Set(['new', 'drafts']);

/** Reads code view text, reporting a problem with its line and column. */
function readCode(
  code: string,
):
  | { content: unknown; diagnostics: [] }
  | { content: null; diagnostics: WorkflowDiagnostic[] } {
  try {
    return { content: parseWorkflowSource(code), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof WorkflowCodeError)) throw error;

    return {
      content: null,
      diagnostics: [
        diagnostic(
          'code_parse',
          `Line ${error.line}, column ${error.column}: ${error.message}`,
          `Code view parse error at ${error.line}:${error.column}`,
          { field: 'code' },
        ),
      ],
    };
  }
}

/** Authors `workflow/2` drafts and publishes them as immutable versions. Drafts never run. */
export function createWorkflowDrafts(deps: {
  /** Owner-provided release evidence fence, checked against the locked exact draft. */
  publicationGuard?(
    context: TenantContext,
    draft: WorkflowDraft,
  ): Promise<string | null>;
  store: WorkflowDraftStore;
  /** Reads published native versions; the same store used by the workflow catalog. */
  versions(
    context: TenantContext,
    definitionId: string,
  ): Promise<PublishedWorkflowVersion[]>;
  /** Definition IDs owned by built-in or Resolution workflows. */
  reserved(context: TenantContext): Promise<Set<string>>;
  sources: VocabularySource[];
  codeStep: Omit<CodeStepSupport, 'executable' | 'reason' | 'evaluation'>;
  parseShape(
    input: unknown,
  ):
    | { content: WorkflowDraftContent; diagnostics: [] }
    | { content: null; diagnostics: WorkflowDiagnostic[] };
  check: Check;
  fromVersion(version: ProcessWorkflowVersion): WorkflowDraftContent;
  /** Returns a template's content for a customized copy. */
  template?(id: string): WorkflowDraftContent;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  hash(value: unknown): string;
  id(): string;
  now(): Date;
}) {
  async function authorize(context: TenantContext, permission: Permission) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function readable(input: unknown): WorkflowDraftContent {
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > maxContentBytes)
      throw conflict(
        'This draft is too large. Remove steps or shorten Code Steps.',
      );
    const parsed = deps.parseShape(input);
    if (!parsed.content)
      throw conflict(
        `This draft can't be read as a workflow. ${parsed.diagnostics[0]?.message ?? ''}`.trim(),
      );

    return parsed.content;
  }

  async function vocabulary(context: TenantContext) {
    const contributions = await Promise.all(
      deps.sources.map((source) => source.vocabulary(context)),
    );

    return mergeVocabulary(contributions, deps.codeStep);
  }

  function view(draft: StoredWorkflowDraft): WorkflowDraft {
    return {
      id: draft.id,
      tenantId: draft.tenantId,
      revision: draft.revision,
      state: draft.state,
      mode: draft.mode,
      content: draft.content,
      codeView: draft.codeView,
      basedOn: draft.basedOn,
      authorId: draft.authorId,
      updatedBy: draft.updatedBy,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      published: draft.published,
    };
  }

  function blank(name: string | undefined): WorkflowDraftContent {
    const suffix = deps.id().replaceAll('-', '').slice(0, 8);

    return {
      schemaVersion: 2,
      definition: {
        id: `custom-${suffix}`,
        name: name?.trim() || 'Untitled workflow',
        intent: '',
        category: 'custom',
      },
      version: '1.0.0',
      applicability: { trigger: { kind: 'manual' }, subjectKind: '' },
      inputs: {},
      context: { kind: 'manual', fields: {}, maxAgeSeconds: 300 },
      steps: [{ id: 'finish', kind: 'end', outcome: 'Completed' }],
    };
  }

  function provenance(
    draft: Pick<WorkflowDraft, 'id' | 'revision' | 'mode'>,
    actorId: string,
    notes?: string,
  ): ProcessWorkflowVersion['provenance'] {
    return {
      kind: 'native',
      reference: `draft:${draft.id}@${draft.revision}`,
      authoredBy: actorId,
      evidenceRefs: [`draft:${draft.id}`],
      authoring: {
        mode: draft.mode,
        draftId: draft.id,
        revision: draft.revision,
        ...(notes ? { notes } : {}),
      },
    };
  }

  async function publicationChecks(
    context: TenantContext,
    content: WorkflowDraftContent,
    basedOn: DraftOrigin | null,
    digest: string | null,
  ) {
    const found: WorkflowDiagnostic[] = [];
    const id = content.definition.id;
    const [published, reserved] = await Promise.all([
      id ? deps.versions(context, id) : Promise.resolve([]),
      deps.reserved(context),
    ]);
    if (pageNames.has(id))
      found.push(
        diagnostic(
          'reserved_definition',
          'This ID is used by a Luma page. Choose another ID.',
          `Definition ${id} is reserved for routing`,
          { field: 'definition.id' },
        ),
      );
    if (reserved.has(id))
      found.push(
        diagnostic(
          'reserved_definition',
          'A built-in workflow already uses this ID. Choose another ID.',
          `Definition ${id} is reserved`,
          { field: 'definition.id' },
        ),
      );
    if (basedOn && basedOn.definitionId !== id)
      found.push(
        diagnostic(
          'origin_changed',
          `This draft edits “${basedOn.definitionId}”. Keep its ID, or start a new workflow instead.`,
          `Draft continues ${basedOn.definitionId} but names ${id}`,
          { field: 'definition.id' },
        ),
      );
    if (published.length && !basedOn)
      found.push(
        diagnostic(
          'definition_taken',
          'A published workflow already uses this ID. Edit that workflow, or choose another ID.',
          `Definition ${id} already has published versions`,
          { field: 'definition.id' },
        ),
      );
    const first = published[0]?.definition;
    if (first)
      for (const field of ['name', 'intent', 'category'] as const)
        if (first[field] !== content.definition[field])
          found.push(
            diagnostic(
              'definition_immutable',
              'Published workflows keep their name, description and category. Start a new workflow to change them.',
              `Definition ${field} differs from the published definition`,
              { field: `definition.${field}` },
            ),
          );
    const versions = published.map((item) => item.version);
    const same = published.find((item) => item.version === content.version);
    const latest = [...versions].sort((a, b) => compareVersions(b, a) ?? 0)[0];
    if (same && same.digest !== digest)
      found.push(
        diagnostic(
          'version_published',
          `Version ${content.version} is already published. Use ${nextVersion(versions)} or higher.`,
          `Version ${content.version} exists with digest ${same.digest}`,
          { field: 'version' },
        ),
      );
    else if (
      !same &&
      latest &&
      (compareVersions(content.version, latest) ?? 1) <= 0
    )
      found.push(
        diagnostic(
          'version_not_newer',
          `Choose a version higher than the latest published version ${latest}.`,
          `Version ${content.version} is not greater than ${latest}`,
          { field: 'version' },
        ),
      );
    if (
      basedOn &&
      latest &&
      latest !== basedOn.version &&
      (compareVersions(latest, basedOn.version) ?? 0) > 0
    )
      found.push(
        diagnostic(
          'newer_published',
          `Version ${latest} was published after this draft started. Check it before publishing.`,
          `Draft started from ${basedOn.version}; latest is ${latest}`,
          { field: 'version', severity: 'warning' },
        ),
      );

    return { found, versions };
  }

  function unreadable(
    draft: StoredWorkflowDraft | null,
    diagnostics: WorkflowDiagnostic[],
  ): DraftValidation {
    return {
      revision: draft?.revision ?? null,
      content: null,
      publishable: false,
      diagnostics,
      steps: [],
      summary: null,
      printed: null,
      publishedVersions: [],
      suggestedVersion: '1.0.0',
    };
  }

  async function validation(
    context: TenantContext,
    input: unknown,
    draft: StoredWorkflowDraft | null,
    notes?: string,
  ): Promise<{
    validation: DraftValidation;
    version: ProcessWorkflowVersion | null;
  }> {
    const shape = deps.parseShape(input);
    const words = await vocabulary(context);
    if (!shape.content)
      return {
        validation: unreadable(draft, shape.diagnostics),
        version: null,
      };
    const content = shape.content;
    const checked = deps.check(
      content,
      provenance(
        draft ?? {
          id: '00000000-0000-4000-8000-000000000000',
          revision: 1,
          mode: 'visual',
        },
        context.actor.id,
        notes,
      ),
    );
    const { found, versions } = await publicationChecks(
      context,
      content,
      draft?.basedOn ?? null,
      checked.version?.digest ?? null,
    );
    const diagnostics = [
      ...checked.diagnostics,
      ...checkVocabulary(content, words),
      ...found,
    ];
    const scopes = stepScopes(content);

    return {
      validation: {
        revision: draft?.revision ?? null,
        content,
        publishable:
          !!checked.version &&
          diagnostics.every((item) => item.severity !== 'error'),
        diagnostics,
        steps: content.steps.map((step, index) => ({
          index,
          id: step.id,
          kind: step.kind,
          ...describeStep(step, words),
          scope: scopes[index] ?? [],
        })),
        summary: summarizeDraft(content, words),
        printed: printWorkflowSource(content),
        publishedVersions: versions,
        suggestedVersion: nextVersion(versions),
      },
      version: checked.version,
    };
  }

  function audit(
    context: TenantContext,
    draft: WorkflowDraft,
    event: 'draft_created' | 'published' | 'draft_discarded',
    extra: Record<string, string> = {},
  ): WorkflowAuditEntry {
    return {
      id: deps.id(),
      tenantId: context.tenantId,
      eventKey: `workflow-draft:${draft.id}:${event}`,
      eventType: `workflow.${event}`,
      schemaVersion: 1,
      occurredAt: draft.updatedAt,
      actor: { kind: 'user', id: context.actor.id },
      correlationId: draft.id,
      proposalId: draft.id,
      actionHash: deps.hash(draft.content),
      evidenceRefs: [
        `draft:${draft.id}`,
        ...(extra.digest ? [extra.digest] : []),
      ],
      details: {
        draftId: draft.id,
        definitionId: draft.content.definition.id,
        name: draft.content.definition.name,
        revision: String(draft.revision),
        mode: draft.mode,
        ...extra,
      },
    };
  }

  async function open(context: TenantContext, id: string) {
    const draft = await deps.store.get(context, id);
    if (!draft || draft.state === 'discarded')
      throw new IdentityError(404, 'NOT_FOUND', 'Draft not found.');

    return draft;
  }

  return {
    /** Explains why installed adapters cannot run a published version. Callers authorize first. */
    async blockers(
      context: TenantContext,
      version: PublishedWorkflowVersion,
    ): Promise<string[]> {
      if (version.format !== 'workflow/2') return [];

      return executionBlockers(
        deps.fromVersion(version),
        await vocabulary(context),
      );
    },
    /** Lists what authors can use here, including entries that cannot run and why. */
    async vocabulary(context: TenantContext): Promise<AuthoringVocabulary> {
      return vocabulary(await authorize(context, 'workflows.read'));
    },
    /** Lists open drafts in the workspace. */
    async list(context: TenantContext) {
      return (
        await deps.store.list(await authorize(context, 'workflows.read'))
      ).map(view);
    },
    /** Reads one draft. Discarded drafts are not found. */
    async get(context: TenantContext, id: string) {
      return view(await open(await authorize(context, 'workflows.read'), id));
    },
    /**
     * Creates a draft. Reuse the same ID and body after an uncertain response; a different body
     * for an existing ID returns a conflict.
     */
    async create(
      context: TenantContext,
      input: { id: string; mode: AuthoringMode; start: DraftStart },
    ) {
      context = await authorize(context, 'workflows.author');
      const createDigest = deps.hash({ ...input, actorId: context.actor.id });
      let content: WorkflowDraftContent;
      let basedOn: DraftOrigin | null = null;
      if (input.start.kind === 'version') {
        const { definitionId, version } = input.start;
        if ((await deps.reserved(context)).has(definitionId))
          throw conflict(
            'Built-in workflows can’t be edited directly. Customize a copy from the template gallery instead.',
          );
        const published = (await deps.versions(context, definitionId)).find(
          (item) => item.version === version,
        );
        if (!published)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Workflow version not found.',
          );
        if (published.format !== 'workflow/2')
          throw conflict(
            'This version uses an older format. Start a new workflow instead.',
          );
        const process = published as ProcessWorkflowVersion;
        basedOn = {
          definitionId,
          version: process.version,
          digest: process.digest,
        };
        const all = await deps.versions(context, definitionId);
        content = {
          ...deps.fromVersion(process),
          version: nextVersion(all.map((item) => item.version)),
        };
      } else if (input.start.kind === 'template') {
        if (!deps.template)
          throw new IdentityError(404, 'NOT_FOUND', 'Template not found.');
        const template = deps.template(input.start.templateId);
        const suffix = deps.id().replaceAll('-', '').slice(0, 6);
        // A customized copy is a new workflow; the published template is never changed.
        content = {
          ...template,
          definition: {
            ...template.definition,
            id: `${template.definition.id.slice(0, 72)}-${suffix}`,
            name: `${template.definition.name} (custom)`.slice(0, 200),
          },
          version: '1.0.0',
        };
      } else
        content =
          input.start.kind === 'content'
            ? readable(input.start.content)
            : blank(input.start.name);
      const now = deps.now().toISOString();
      const draft: StoredWorkflowDraft = {
        id: input.id,
        tenantId: context.tenantId,
        revision: 1,
        state: 'draft',
        mode: input.mode,
        content,
        codeView: null,
        basedOn,
        authorId: context.actor.id,
        updatedBy: context.actor.id,
        createdAt: now,
        updatedAt: now,
        published: null,
        createDigest,
        lastSave: null,
      };

      return deps.store.transaction(context, async (tx) => {
        if (await tx.insert(draft)) {
          await tx.audit(audit(context, draft, 'draft_created'));

          return view(draft);
        }
        const existing = await tx.lock(input.id);
        if (!existing || existing.createDigest !== createDigest)
          throw conflict('This draft ID was already used. Start a new draft.');

        return view(existing);
      });
    },
    /**
     * Saves new content when `revision` is still current. A stale revision returns a conflict so
     * concurrent edits are never overwritten. Reusing `saveId` with the same body is safe.
     */
    async save(
      context: TenantContext,
      id: string,
      input: {
        saveId: string;
        revision: number;
        mode: AuthoringMode;
        content: unknown;
        codeView?: string | null | undefined;
      },
    ) {
      context = await authorize(context, 'workflows.author');
      const content = readable(input.content);
      if (input.codeView) {
        const code = readCode(input.codeView);
        if (!code.content) throw conflict(code.diagnostics[0]!.message);
        if (deps.hash(code.content) !== deps.hash(content))
          throw conflict(
            'The code view and the draft content differ. Reload the draft and try again.',
          );
      }
      const digest = deps.hash({
        revision: input.revision,
        mode: input.mode,
        content,
        codeView: input.codeView ?? null,
        actorId: context.actor.id,
      });

      return deps.store.transaction(context, async (tx) => {
        const current = await tx.lock(id);
        if (!current || current.state === 'discarded')
          throw new IdentityError(404, 'NOT_FOUND', 'Draft not found.');
        if (current.lastSave?.id === input.saveId) {
          if (current.lastSave.digest !== digest)
            throw conflict(
              'This save ID was already used with different content.',
            );

          return view(current);
        }
        if (current.state !== 'draft')
          throw conflict(
            'This draft was already published. Edit the workflow to start a new draft.',
          );
        if (current.revision !== input.revision)
          throw conflict(
            'Someone else saved this draft. Reload it to see their changes before editing.',
          );
        const next: StoredWorkflowDraft = {
          ...current,
          revision: current.revision + 1,
          mode: input.mode,
          content,
          codeView: input.codeView ?? null,
          updatedBy: context.actor.id,
          updatedAt: deps.now().toISOString(),
          lastSave: { id: input.saveId, digest },
        };
        await tx.update(next);

        return view(next);
      });
    },
    /** Checks stored or supplied content without saving it. */
    async validate(
      context: TenantContext,
      input: {
        draftId?: string | undefined;
        content?: unknown;
        code?: string | undefined;
      },
    ): Promise<DraftValidation> {
      context = await authorize(context, 'workflows.read');
      const draft = input.draftId ? await open(context, input.draftId) : null;
      const code = input.code === undefined ? null : readCode(input.code);
      if (code && !code.content) return unreadable(draft, code.diagnostics);
      const result = await validation(
        context,
        code?.content ??
          (input.content === undefined ? draft?.content : input.content),
        draft,
      );

      return result.validation;
    },
    /**
     * Publishes the exact draft revision as an immutable version. Publication never activates the
     * workflow or grants execution authority. Retrying the same revision returns the same version.
     */
    async publish(
      context: TenantContext,
      id: string,
      input: { revision: number; notes?: string | undefined },
    ) {
      context = await authorize(context, 'workflows.publish');

      return deps.store.transaction(context, async (tx) => {
        const draft = await tx.lock(id);
        if (!draft || draft.state === 'discarded')
          throw new IdentityError(404, 'NOT_FOUND', 'Draft not found.');
        if (draft.revision !== input.revision)
          throw conflict(
            'This draft changed after you reviewed it. Review the latest revision before publishing.',
          );
        const result = await validation(
          context,
          draft.content,
          draft,
          input.notes,
        );
        if (draft.state === 'published') {
          if (draft.published?.digest !== result.version?.digest)
            throw conflict('This draft was already published.');

          return { draft: view(draft), version: result.version! };
        }
        if (!result.version || !result.validation.publishable)
          throw conflict(
            `Fix ${result.validation.diagnostics.filter((item) => item.severity === 'error').length} problem(s) before publishing.`,
          );
        const blocked = await deps.publicationGuard?.(context, view(draft));
        if (blocked) throw conflict(blocked);
        await tx.publish(result.version);
        const now = deps.now().toISOString();
        const published: StoredWorkflowDraft = {
          ...draft,
          state: 'published',
          updatedAt: now,
          updatedBy: context.actor.id,
          published: {
            version: result.version.version,
            digest: result.version.digest,
            publishedAt: now,
            publishedBy: context.actor.id,
          },
        };
        await tx.update(published);
        await tx.audit(
          audit(context, published, 'published', {
            version: result.version.version,
            digest: result.version.digest,
          }),
        );

        return { draft: view(published), version: result.version };
      });
    },
    /** Discards an unpublished draft. Discarding it again is safe. */
    async discard(
      context: TenantContext,
      id: string,
      input: { revision: number },
    ) {
      context = await authorize(context, 'workflows.author');

      return deps.store.transaction(context, async (tx) => {
        const draft = await tx.lock(id);
        if (!draft)
          throw new IdentityError(404, 'NOT_FOUND', 'Draft not found.');
        if (draft.state === 'discarded') return { discarded: true as const };
        if (draft.state === 'published')
          throw conflict('Published drafts are kept as provenance.');
        if (draft.revision !== input.revision)
          throw conflict(
            'Someone else changed this draft. Reload it before discarding.',
          );
        const discarded: StoredWorkflowDraft = {
          ...draft,
          state: 'discarded',
          updatedAt: deps.now().toISOString(),
          updatedBy: context.actor.id,
        };
        await tx.update(discarded);
        await tx.audit(audit(context, discarded, 'draft_discarded'));

        return { discarded: true as const };
      });
    },
  };
}

export type WorkflowDrafts = ReturnType<typeof createWorkflowDrafts>;
