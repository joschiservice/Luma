import { randomUUID } from 'node:crypto';

import { makeTenantContext } from '@luma/identity/composition';
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
        dataRegion: 'EU',
        status: 'active',
      },
      {
        id: 'membership',
        organizationId: tenantId,
        userId: 'owner',
        role: 'owner',
      },
      'request',
    );
    const commands = createWorkflowCommands(
      env.client,
      `shadow-${randomUUID()}`,
      { refreshContext: async (value) => value },
    );
    const source = { kind: 'incident' as const, id: randomUUID() };
    const shadow = { id: randomUUID(), workflow: 'shipping' };
    const started = await commands.startShadow(context, source, shadow);
    try {
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
