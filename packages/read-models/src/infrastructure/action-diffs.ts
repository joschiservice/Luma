import {
  type ActionDiff,
  describeActionDiff,
  type EffectIntent,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { sqlUuid } from '@luma/platform';

/** An immutable action reference selected by an authorized owner's read model. */
export type ActionDiffReference =
  { proposalId: string } | { runId: string; stepId: string };

/**
 * Reads bounded action reviews from immutable admission/case proposals. Callers must select
 * references through an authorized owner; this is not a public arbitrary-proposal endpoint.
 * Missing actions remain null and no read executes policy, models or provider preconditions.
 */
export function createActionDiffReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    references: {
      id: string;
      reference: ActionDiffReference;
      observedAt: string | null;
      canonical?: { kind: string; id: string } | null;
      evidenceLink?: string;
    }[],
  ): Promise<Map<string, ActionDiff | null>> => {
    requireTenant(context, context.tenantId);
    if (references.length > 100)
      throw new Error('Action review exceeds its bounded page.');
    if (!references.length) return new Map();
    const requested = references.map(({ id, reference }) => ({
      id,
      proposalId: 'proposalId' in reference ? reference.proposalId : null,
      runId: 'runId' in reference ? reference.runId : null,
      stepId: 'stepId' in reference ? reference.stepId : null,
    }));
    const actions = await db.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{
            id: string;
            action: EffectIntent;
            policy: ActionDiff['policy'];
          }>(
            `WITH requested AS MATERIALIZED (
         SELECT r.id,${sqlUuid('r."proposalId"')} AS proposal_id,${sqlUuid('r."runId"')} AS run_id,r."stepId" AS step_id
         FROM jsonb_to_recordset($2::jsonb) AS r(id text,"proposalId" text,"runId" text,"stepId" text)
       ) SELECT r.id,COALESCE(s.document->'action',p.document) AS action,
         (SELECT jsonb_build_object('outcome',d.document->>'outcome','reason',d.document->>'reason',
            'evaluatedAt',d.document->>'evaluatedAt','validUntil',d.document->>'validUntil',
            'current',false) FROM policy_decisions d
          WHERE d.tenant_id=$1 AND d.proposal_id=${sqlUuid("COALESCE(s.document->'action',p.document)->>'id'")}
          ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS policy
       FROM requested r
       LEFT JOIN action_admission_steps s ON s.tenant_id=$1 AND
         (s.proposal_id=r.proposal_id OR (s.run_id=r.run_id AND s.step_id=r.step_id))
       LEFT JOIN case_proposals p ON p.tenant_id=$1 AND p.id=r.proposal_id
       WHERE COALESCE(s.document->'action',p.document) IS NOT NULL`,
            [context.tenantId, JSON.stringify(requested)],
          )
        ).rows,
      { readOnlySnapshot: true },
    );
    const baselines = new Map<string, Record<string, unknown>>();
    const stores = {
      shopify_inventory_correction: 'shopify_inventory_corrections',
      shopify_order_edit: 'shopify_order_edits',
      shopify_fulfillment: 'shopify_fulfillment_recoveries',
      shopify_shipment_publication: 'shopify_shipment_publications',
    };
    for (const [kind, table] of Object.entries(stores)) {
      const selected = actions.filter((row) => row.action.target.kind === kind);
      if (!selected.length) continue;
      const rows = await db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; before: Record<string, unknown> }>(
              `SELECT id::text,document->'before' AS before FROM ${table} WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
              [context.tenantId, selected.map((row) => row.action.target.id)],
            )
          ).rows,
        { readOnlySnapshot: true },
      );
      for (const row of rows) baselines.set(`${kind}:${row.id}`, row.before);
    }
    const byId = new Map(actions.map((row) => [row.id, row]));

    return new Map(
      references.map(({ id, observedAt, canonical, evidenceLink }) => {
        const row = byId.get(id);
        const baseline = row
          ? baselines.get(`${row.action.target.kind}:${row.action.target.id}`)
          : undefined;
        const source = baseline?.source;
        const times = [
          baseline?.observedAt,
          source && typeof source === 'object' && 'observedAt' in source
            ? source.observedAt
            : null,
          observedAt,
        ].filter(
          (value): value is string =>
            typeof value === 'string' && Number.isFinite(Date.parse(value)),
        );
        // The source and target must both remain fresh; the oldest pinned read bounds authority.
        const observation = times.length
          ? times.reduce((oldest, value) =>
              Date.parse(value) < Date.parse(oldest) ? value : oldest,
            )
          : null;
        const diff = row
          ? describeActionDiff(row.action, observation, baseline)
          : null;
        if (diff) {
          if (evidenceLink) diff.evidence.link = evidenceLink;
          diff.evidence.ageSeconds =
            observation && Date.parse(observation) <= Date.now()
              ? Math.floor((Date.now() - Date.parse(observation)) / 1000)
              : null;
          if (
            canonical &&
            diff.records.every((record) => record.system !== 'luma')
          ) {
            const paths: Record<string, string> = {
              order: 'orders',
              fulfillment: 'fulfillment',
              position: 'inventory',
              sku: 'products',
              product: 'products',
            };
            const path = paths[canonical.kind];
            diff.records.push({
              system: 'luma',
              connectionId: null,
              ...canonical,
              ...(path
                ? { link: `/app/${context.tenantId}/${path}/${canonical.id}` }
                : {}),
              // The owner's provider snapshot does not establish the canonical projection's values.
              changes: [
                {
                  field: 'projection',
                  before: null,
                  beforeKnown: false,
                  after: null,
                  afterKnown: false,
                  expected: null,
                  expectedKnown: false,
                },
              ],
            });
          }
        }

        // A persisted result describes the reviewed intent. Only its owner may assert that current
        // policy and membership still authorize dispatch; the queue exposes it as recorded history.
        return [id, diff ? { ...diff, policy: row?.policy ?? null } : null];
      }),
    );
  };
}
