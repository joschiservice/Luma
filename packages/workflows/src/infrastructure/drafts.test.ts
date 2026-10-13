import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import {
  createWorkflowDrafts,
  type StoredWorkflowDraft,
  type WorkflowAuditEntry,
  type WorkflowDraftStore,
} from '../application/drafts.js';
import { codeRuntime } from '../domain/code-step.js';
import { processSource } from '../domain/process.fixture.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import type { VocabularyContribution } from '../domain/vocabulary.js';
import { printWorkflowSource } from '../domain/workflow-code.js';
import { playbookHash } from './playbooks/schema.js';
import {
  checkDraftContent,
  draftFromVersion,
  parseDraftShape,
} from './process-schema.js';

const tenantId = 'tenant';

function context(role: 'owner' | 'admin' | 'member', userId = `${role}-id`) {
  return makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Tenant',
      slug: 'tenant',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: `membership-${userId}`, organizationId: tenantId, userId },
      role,
    ),
    'request',
  );
}

const computation: VocabularyContribution = {
  triggers: [{ kind: 'manual', executable: true }],
  subjects: [
    {
      kind: 'order',
      label: 'Order',
      description: '',
      executable: true,
      reason: null,
    },
  ],
  stepKinds: (['code', 'condition', 'wait', 'end'] as const).map((kind) => ({
    kind,
    executable: true,
  })),
  codeSteps: { executable: true, reason: null, evaluation: true },
};

const source = {
  schemaVersion: processSource.schemaVersion,
  definition: processSource.definition,
  version: processSource.version,
  applicability: processSource.applicability,
  inputs: processSource.inputs,
  context: processSource.context,
  steps: processSource.steps,
};
const content = {
  ...source,
  definition: { ...source.definition, id: 'restock-check' },
  inputs: {},
  steps: [
    { ...source.steps[1]!, id: 'ready' },
    { id: 'pause', kind: 'wait' as const, seconds: 5 },
    { id: 'done', kind: 'end' as const, outcome: 'Checked' },
  ],
};

function setup(publicationGuard?: () => Promise<string | null>) {
  const drafts = new Map<string, StoredWorkflowDraft>();
  const published: ProcessWorkflowVersion[] = [];
  const audit: WorkflowAuditEntry[] = [];
  let queue = Promise.resolve();
  const store: WorkflowDraftStore = {
    list: async () => [...drafts.values()].filter((d) => d.state === 'draft'),
    get: async (_context, id) => structuredClone(drafts.get(id) ?? null),
    transaction: (_context, operation) => {
      const run = queue.then(async () => {
        const staged = new Map(drafts);
        const versions: ProcessWorkflowVersion[] = [];
        const entries: WorkflowAuditEntry[] = [];
        const result = await operation({
          lock: async (id) => structuredClone(staged.get(id) ?? null),
          insert: async (draft) => {
            if (staged.has(draft.id)) return false;
            staged.set(draft.id, structuredClone(draft));

            return true;
          },
          update: async (draft) => {
            staged.set(draft.id, structuredClone(draft));
          },
          publish: async (version) => {
            versions.push(version);
          },
          audit: async (entry) => {
            entries.push(entry);
          },
        });
        for (const [id, draft] of staged) drafts.set(id, draft);
        published.push(...versions);
        audit.push(...entries);

        return result;
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };
  const service = createWorkflowDrafts({
    ...(publicationGuard ? { publicationGuard } : {}),
    store,
    versions: async (_context, id) =>
      published.filter((item) => item.definition.id === id),
    reserved: async () => new Set(['inventory-replenishment']),
    sources: [{ vocabulary: async () => computation }],
    codeStep: {
      runtime: codeRuntime,
      limits: {
        fuel: 100_000_000,
        memoryBytes: 67_108_864,
        wallTimeMs: 5000,
        maxRequests: 0,
      },
    },
    parseShape: parseDraftShape,
    check: checkDraftContent,
    fromVersion: draftFromVersion,
    refreshContext: async (item) => item,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date('2026-09-28T10:00:00Z'),
  });

  return { service, drafts, published, audit };
}

describe('workflow drafts', () => {
  it('fences a valid exact revision until independent release evidence exists, without publication side effects', async () => {
    let blocked = true;
    const env = setup(async () =>
      blocked ? 'Trusted historical replay is missing.' : null,
    );
    const admin = context('admin');
    const id = randomUUID();
    await env.service.create(admin, {
      id,
      mode: 'visual',
      start: { kind: 'content', content },
    });
    await expect(
      env.service.publish(admin, id, { revision: 1 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Trusted historical replay is missing.',
    });
    expect(env.published).toEqual([]);
    expect(env.drafts.get(id)?.state).toBe('draft');
    expect(
      env.audit.some((entry) => entry.eventType === 'workflow.published'),
    ).toBe(false);
    blocked = false;
    expect(
      (await env.service.publish(admin, id, { revision: 1 })).draft.state,
    ).toBe('published');
  });
  it('creates, saves, validates and publishes a native version without activating it', async () => {
    const { service, published, audit } = setup();
    const admin = context('admin');
    const id = randomUUID();
    const draft = await service.create(admin, {
      id,
      mode: 'visual',
      start: { kind: 'content', content },
    });
    expect(draft).toEqual(
      expect.objectContaining({ revision: 1, state: 'draft', mode: 'visual' }),
    );
    expect(
      await service.create(admin, {
        id,
        mode: 'visual',
        start: { kind: 'content', content },
      }),
    ).toEqual(draft);
    await expect(
      service.create(admin, { id, mode: 'code', start: { kind: 'blank' } }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const saveId = randomUUID();
    const codeView = `// Edited in code\n${printWorkflowSource(content)}`;
    await expect(
      service.save(admin, id, {
        saveId: randomUUID(),
        revision: 1,
        mode: 'code',
        content: { ...content, version: '2.0.0' },
        codeView,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const saved = await service.save(admin, id, {
      saveId,
      revision: 1,
      mode: 'code',
      content: { ...content, version: '1.0.0' },
      codeView,
    });
    expect(saved.revision).toBe(2);
    expect(
      await service.save(admin, id, {
        saveId,
        revision: 1,
        mode: 'code',
        content: { ...content, version: '1.0.0' },
        codeView,
      }),
    ).toEqual(saved);

    const validation = await service.validate(context('member'), {
      draftId: id,
    });
    expect(validation.publishable).toBe(true);
    expect(validation.summary).toContain('When someone starts it');
    expect(validation.steps[1]!.scope.map((item) => item.field)).toContain(
      'ready',
    );

    const result = await service.publish(admin, id, {
      revision: 2,
      notes: 'First version',
    });
    expect(result.version.provenance).toEqual({
      kind: 'native',
      reference: `draft:${id}@2`,
      authoredBy: admin.actor.id,
      evidenceRefs: [`draft:${id}`],
      authoring: {
        mode: 'code',
        draftId: id,
        revision: 2,
        notes: 'First version',
      },
    });
    expect(published).toEqual([result.version]);
    expect(
      await service.publish(admin, id, { revision: 2, notes: 'First version' }),
    ).toEqual(result);
    expect(published).toHaveLength(1);
    expect(audit.map((item) => item.eventType)).toEqual([
      'workflow.draft_created',
      'workflow.published',
    ]);
    await expect(
      service.save(admin, id, {
        saveId: randomUUID(),
        revision: 2,
        mode: 'visual',
        content,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('returns a conflict instead of overwriting a concurrent save', async () => {
    const { service } = setup();
    const admin = context('admin');
    const owner = context('owner');
    const id = randomUUID();
    await service.create(admin, {
      id,
      mode: 'visual',
      start: { kind: 'blank', name: 'Check stock' },
    });
    const results = await Promise.allSettled(
      [admin, owner].map((actor) =>
        service.save(actor, id, {
          saveId: randomUUID(),
          revision: 1,
          mode: 'visual',
          content: {
            ...content,
            definition: { ...content.definition, name: actor.actor.id },
          },
        }),
      ),
    );
    expect(results.map((item) => item.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
  });

  it('lets members read and validate drafts but not change or publish them', async () => {
    const { service } = setup();
    const member = context('member');
    const id = randomUUID();
    await service.create(context('owner'), {
      id,
      mode: 'visual',
      start: { kind: 'content', content },
    });
    expect(await service.list(member)).toHaveLength(1);
    expect((await service.get(member, id)).id).toBe(id);
    await expect(
      service.create(member, {
        id: randomUUID(),
        mode: 'visual',
        start: { kind: 'blank' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.publish(member, id, { revision: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.discard(member, id, { revision: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires a newer version when editing a published workflow and blocks built-in IDs', async () => {
    const { service } = setup();
    const admin = context('admin');
    const first = randomUUID();
    await service.create(admin, {
      id: first,
      mode: 'visual',
      start: { kind: 'content', content },
    });
    await service.publish(admin, first, { revision: 1 });

    const edit = await service.create(admin, {
      id: randomUUID(),
      mode: 'visual',
      start: {
        kind: 'version',
        definitionId: 'restock-check',
        version: '1.0.0',
      },
    });
    expect(edit.content.version).toBe('1.1.0');
    expect(edit.basedOn).toEqual(
      expect.objectContaining({
        definitionId: 'restock-check',
        version: '1.0.0',
      }),
    );
    await service.save(admin, edit.id, {
      saveId: randomUUID(),
      revision: 1,
      mode: 'visual',
      content: { ...edit.content, version: '1.0.0' },
    });
    const stale = await service.validate(admin, { draftId: edit.id });
    expect(stale.publishable).toBe(false);
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'version_published', field: 'version' }),
    );

    const copy = await service.validate(admin, { content });
    expect(copy.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'definition_taken',
        field: 'definition.id',
      }),
    );
    const builtIn = await service.validate(admin, {
      content: {
        ...content,
        definition: { ...content.definition, id: 'inventory-replenishment' },
      },
    });
    expect(builtIn.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'reserved_definition' }),
    );
    await expect(
      service.create(admin, {
        id: randomUUID(),
        mode: 'visual',
        start: {
          kind: 'version',
          definitionId: 'inventory-replenishment',
          version: '1.0.0',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to publish invalid drafts and discards safely', async () => {
    const { service, audit } = setup();
    const admin = context('admin');
    const id = randomUUID();
    await service.create(admin, {
      id,
      mode: 'visual',
      start: { kind: 'blank' },
    });
    const validation = await service.validate(admin, { draftId: id });
    expect(validation.publishable).toBe(false);
    await expect(
      service.publish(admin, id, { revision: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.discard(admin, id, { revision: 1 })).toEqual({
      discarded: true,
    });
    expect(await service.discard(admin, id, { revision: 1 })).toEqual({
      discarded: true,
    });
    await expect(service.get(admin, id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(audit.map((item) => item.eventType)).toEqual([
      'workflow.draft_created',
      'workflow.draft_discarded',
    ]);
  });
});
