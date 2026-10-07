import type { Permission } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { RecordKind } from '../domain/answer.js';
import { createToolRegistry, defineTool } from './tools.js';

const tenantId = '00000000-0000-4000-8000-000000000001';

/** A resolved context holding a built-in role, or a custom role with exactly these grants. */
function context(access: 'member' | readonly Permission[]) {
  const member = { id: 'membership', organizationId: tenantId, userId: 'u' };

  return makeTenantContext(
    { userId: 'u', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      status: 'active',
      dataRegion: 'EU',
    },
    access === 'member'
      ? builtInMembership(member, 'member')
      : {
          ...member,
          role: {
            id: 'role',
            key: 'custom',
            name: 'Custom',
            builtIn: false,
            revision: 1,
          },
          permissions: new PermissionSet(access),
        },
    'request',
  );
}

function tool(name: string, reads: RecordKind, permission: Permission) {
  const run = vi.fn(async () => ({ data: { name }, records: [] }));

  return {
    run,
    tool: defineTool((value) => ({ input: value }), {
      name,
      label: name,
      description: name,
      reads,
      permission,
      jsonSchema: { type: 'object' },
      describe: () => name,
      run,
    }),
  };
}

function registry() {
  const orders = tool('search_orders', 'order', 'orders.read');
  const issues = tool('search_issues', 'issue', 'issues.read');
  const stock = tool('search_stock', 'stock_position', 'inventory.read');

  return {
    orders,
    registry: createToolRegistry([orders.tool, issues.tool, stock.tool]),
  };
}

describe('Assistant tool permissions', () => {
  it('offers the model only tools the person may use', () => {
    const { registry: tools } = registry();
    const person = context(['assistant.use', 'issues.read']);

    expect(tools.declarations(person).map((tool) => tool.name)).toEqual([
      'search_issues',
    ]);
    expect(tools.reads(person)).toEqual(['issue']);
  });

  it('offers built-in members every read tool', () => {
    const { registry: tools } = registry();

    expect(
      tools.declarations(context('member')).map((tool) => tool.name),
    ).toEqual(['search_orders', 'search_issues', 'search_stock']);
  });

  it('refuses a call to a tool the person lacks without reading', async () => {
    const { registry: tools, orders } = registry();
    const result = await tools.execute(
      context(['assistant.use', 'issues.read']),
      { name: 'search_orders', arguments: {} },
    );

    expect(orders.run).not.toHaveBeenCalled();
    expect(result.step.outcome).toBe('failed');
    expect(JSON.parse(result.content)).toMatchObject({
      error: 'not_permitted',
    });
    expect(result.records).toEqual([]);
  });
});
