import { makeTenantContext } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  compileProcessWorkflow,
  createWorkflows,
  defineCodeStep,
} from '@luma/workflows/composition';
import { Pool } from 'pg';

/** Publishes a deterministic calculation under the workspace owner's authority. */
export async function seedCodeSteps(db, tenantId) {
  const org = (
    await db.owner.query('SELECT * FROM organizations WHERE id=$1', [tenantId])
  ).rows[0];
  const member = (
    await db.owner.query(
      "SELECT * FROM memberships WHERE tenant_id=$1 AND role='owner'",
      [tenantId],
    )
  ).rows[0];
  const context = makeTenantContext(
    { userId: member.user_id, sessionId: 'fixture' },
    { ...org, dataRegion: org.data_region, status: 'active' },
    {
      id: member.id,
      organizationId: tenantId,
      userId: member.user_id,
      role: 'owner',
    },
    'fixture',
  );
  const pool = new Pool({ connectionString: db.runtimeUrl });
  try {
    const catalog = createWorkflows(
      createTenantDatabase(pool),
      {},
      async () => context,
    );
    const version = compileProcessWorkflow({
      schemaVersion: 2,
      definition: {
        id: 'quantity-calculation',
        name: 'Calculate replenishment quantity',
        intent: 'Calculate the quantity needed to restore stock.',
        category: 'procurement',
      },
      version: '1.0.0',
      applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
      inputs: { quantity: 'number' },
      context: { kind: 'stock', fields: {}, maxAgeSeconds: 300 },
      steps: [
        defineCodeStep({
          id: 'calculate',
          source:
            'function main(input: { inputs: { quantity: number } }) { return { value: input.inputs.quantity * 2 }; }',
          fields: { value: 'number' },
          grants: [],
          limits: {
            fuel: 100000000,
            memoryBytes: 67108864,
            wallTimeMs: 5000,
            maxRequests: 0,
          },
        }),
        { id: 'finish', kind: 'end', outcome: 'calculated' },
      ],
      provenance: {
        kind: 'resolution',
        reference: 'fixture',
        authoredBy: 'operator',
        evidenceRefs: ['stock'],
      },
    });
    await catalog.publish(context, version);

    return { version, context };
  } finally {
    await pool.end();
  }
}
