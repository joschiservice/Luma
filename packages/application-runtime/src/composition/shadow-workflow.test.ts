import { randomUUID } from 'node:crypto';

import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createWorkflowCommands } from '@luma/workflow-temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { expect, it } from 'vitest';

it('reuses exact Shadow starts and rejects conflicting principal, source or Playbook', async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const tenantId = randomUUID();
    const context = makeTenantContext(
      { userId: 'owner', sessionId: 'session' },
      {
        id: tenantId,
        name: 'Shadow',
        slug: 'shadow',
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: 'membership', organizationId: tenantId, userId: 'owner' },
        'owner',
      ),
      'request',
    );
    const commands = createWorkflowCommands(
      env.client,
      `shadow-${randomUUID()}`,
      { refreshContext: async (value) => value },
      'AU',
    );
    const source = { kind: 'incident' as const, id: randomUUID() };
    const shadow = { id: randomUUID(), workflow: 'shipping' };
    const started = await commands.startShadow(context, source, shadow);
    try {
      expect(started.workflowId).not.toContain(tenantId);
      expect(started.workflowId).not.toContain(shadow.id);
      const details = await env.client.workflow
        .getHandle(started.workflowId)
        .describe();
      expect(details.memo?.shadowRequest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(details.memo)).not.toContain(tenantId);
      expect(
        await commands.startShadow(
          { ...context, requestId: 'retry' },
          source,
          shadow,
        ),
      ).toEqual(started);
      await expect(
        commands.startShadow(context, source, { ...shadow, workflow: 'other' }),
      ).rejects.toThrow('different request');
      await expect(
        commands.startShadow(context, { ...source, id: randomUUID() }, shadow),
      ).rejects.toThrow('different request');
      await expect(
        commands.startShadow(
          { ...context, actor: { ...context.actor, id: 'other' } },
          source,
          shadow,
        ),
      ).rejects.toThrow('different request');
    } finally {
      await env.client.workflow.getHandle(started.workflowId).terminate();
    }
    expect(await commands.startShadow(context, source, shadow)).toEqual(
      started,
    );
  } finally {
    await env.teardown();
  }
});
