import { randomUUID } from 'node:crypto';

import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict, invalid } from '@luma/platform';

import type {
  AutonomyAudit,
  AutonomyRepository,
} from '../application/scoped-autonomy.js';
import type {
  AutonomyAdmission,
  AutonomyHistory,
  ScopedAutonomyPolicy,
} from '../domain/scoped-autonomy.js';
import {
  autonomyDecimal,
  evaluateAutonomy,
} from '../domain/scoped-autonomy.js';

/** Shares the dispatch/control fence so a committed pause prevents a new reservation. */
async function fence(tx: SqlTransaction, tenantId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `exceptions:${tenantId}`,
  ]);
}

async function persistRevision(
  tx: SqlTransaction,
  policy: ScopedAutonomyPolicy,
  event: AutonomyAudit,
) {
  await tx.query(
    'INSERT INTO autonomy_policies(tenant_id,id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET revision=EXCLUDED.revision,document=EXCLUDED.document',
    [policy.tenantId, policy.id, policy.revision, policy],
  );
  await tx.query(
    'INSERT INTO autonomy_policy_revisions(tenant_id,policy_id,revision,document) VALUES($1,$2,$3,$4)',
    [policy.tenantId, policy.id, policy.revision, policy],
  );
  await tx.query(
    'INSERT INTO autonomy_epochs(tenant_id,revision) VALUES($1,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=autonomy_epochs.revision+1',
    [policy.tenantId],
  );
  await tx.query(
    'INSERT INTO autonomy_outbox(tenant_id,id,document) VALUES($1,$2,$3)',
    [policy.tenantId, event.id, event],
  );
}

/** Owns tenant-scoped policy revisions, history and reservation limits. */
export function createAutonomyRepository(
  db: TenantDatabase,
): AutonomyRepository {
  return {
    list: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: ScopedAutonomyPolicy }>(
            'SELECT document FROM autonomy_policies WHERE tenant_id=$1 ORDER BY id',
            [tenantId],
          )
        ).rows.map((row) => row.document),
      ),
    proposal: (tenantId, id) =>
      db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ document: AutonomyHistory }>(
              'SELECT document FROM autonomy_history WHERE tenant_id=$1 AND proposal_id=$2',
              [tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    history: (tenantId, id) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: AutonomyHistory }>(
            'SELECT document FROM autonomy_history WHERE tenant_id=$1 AND policy_id=$2 ORDER BY updated_at DESC,proposal_id DESC LIMIT 100',
            [tenantId, id],
          )
        ).rows.map((row) => row.document),
      ),
    epoch: (tenantId) =>
      db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ revision: number }>(
              'SELECT revision FROM autonomy_epochs WHERE tenant_id=$1',
              [tenantId],
            )
          ).rows[0]?.revision ?? 0,
      ),
    pending: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: AutonomyAudit }>(
            'SELECT document FROM autonomy_outbox WHERE tenant_id=$1 AND delivered_at IS NULL ORDER BY created_at,id',
            [tenantId],
          )
        ).rows.map((row) => row.document),
      ),
    delivered: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'UPDATE autonomy_outbox SET delivered_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
      }),
    mutate: (
      context,
      id,
      commandId,
      fingerprint,
      expectedRevision,
      reason,
      apply,
    ) =>
      db.transaction(context.tenantId, async (tx) => {
        await fence(tx, context.tenantId);
        const previousCommand = (
          await tx.query<{
            fingerprint: string;
            document: ScopedAutonomyPolicy;
          }>(
            'SELECT fingerprint,document FROM autonomy_commands WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, commandId],
          )
        ).rows[0];
        if (previousCommand) {
          if (previousCommand.fingerprint !== fingerprint)
            throw conflict(
              'Command ID is already bound to another reviewed change.',
            );

          return previousCommand.document;
        }
        const current =
          (
            await tx.query<{ document: ScopedAutonomyPolicy }>(
              'SELECT document FROM autonomy_policies WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null;
        if ((current?.revision ?? 0) !== expectedRevision)
          throw conflict(
            'Policy changed. Refresh it before making another decision.',
          );
        const history = (
          await tx.query<{ document: AutonomyHistory }>(
            'SELECT document FROM autonomy_history WHERE tenant_id=$1 AND policy_id=$2 ORDER BY updated_at DESC,proposal_id DESC LIMIT 100',
            [context.tenantId, id],
          )
        ).rows.map((row) => row.document);
        const policy = await apply(current, history);
        const connections = await tx.query(
          'SELECT id FROM connector_installations WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
          [context.tenantId, policy.scope.connectionIds],
        );
        if (
          (connections.rowCount ?? 0) +
            (policy.scope.connectionIds.includes(context.tenantId) ? 1 : 0) !==
          policy.scope.connectionIds.length
        )
          throw invalid(
            'Every scoped connection must belong to this workspace.',
          );
        await persistRevision(tx, policy, {
          id: commandId,
          tenantId: context.tenantId,
          policyId: id,
          revision: policy.revision,
          actorId: context.actor.id,
          correlationId: context.requestId,
          at: policy.updatedAt,
          previousMode: current?.mode ?? null,
          mode: policy.mode,
          reason,
        });
        await tx.query(
          'INSERT INTO autonomy_commands(tenant_id,id,fingerprint,document) VALUES($1,$2,$3,$4)',
          [context.tenantId, commandId, fingerprint, policy],
        );

        return policy;
      }),
    recordProposal: (tenantId, entry) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO autonomy_history(tenant_id,proposal_id,policy_id,document) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,proposal_id) DO NOTHING',
          [tenantId, entry.proposalId, entry.policyId, entry],
        );
      }),
    recordReview: (tenantId, proposalId, outcome) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          "UPDATE autonomy_history SET document=jsonb_set(document,'{review}',to_jsonb($3::text)),updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2 AND document->>'review'='not_reviewed'",
          [
            tenantId,
            proposalId,
            outcome === 'approved' ? 'accepted' : 'overridden',
          ],
        );
      }),
  };
}

/** Consumes exact quantity/exposure inside the execution owner's reservation transaction. */
export async function reserveAutonomy(
  tx: SqlTransaction,
  tenantId: string,
  proposalId: string,
  admission: AutonomyAdmission,
  now: Date,
) {
  await fence(tx, tenantId);
  const policy = (
    await tx.query<{ document: ScopedAutonomyPolicy }>(
      'SELECT document FROM autonomy_policies WHERE tenant_id=$1 AND id=$2',
      [tenantId, admission.policyId],
    )
  ).rows[0]?.document;
  if (
    !policy ||
    policy.revision !== admission.revision ||
    policy.scopeHash !== admission.scopeHash ||
    evaluateAutonomy(policy, admission.facts, now.getTime(), 'low', 'low')
      .outcome === 'denied'
  )
    throw conflict(
      'Scoped policy or evidence changed before reservation. Review a fresh proposal.',
    );
  const day = now.toISOString().slice(0, 10);
  const usage = (
    await tx.query<{ quantity: string; exposure: string }>(
      'SELECT COALESCE(sum(quantity),0)::text AS quantity,COALESCE(sum(exposure),0)::text AS exposure FROM autonomy_reservations WHERE tenant_id=$1 AND policy_id=$2 AND budget_day=$3::date',
      [tenantId, policy.id, day],
    )
  ).rows[0]!;
  const quantity = autonomyDecimal(admission.facts.quantity),
    previous = autonomyDecimal(usage.quantity),
    limit = autonomyDecimal(policy.scope.dailyQuantity);
  if (
    quantity === null ||
    previous === null ||
    limit === null ||
    previous + quantity > limit
  )
    throw conflict(
      'The scoped daily quantity limit is exhausted. No action was dispatched.',
    );
  const exposure = admission.facts.exposure?.amount ?? null;
  if (policy.scope.money) {
    const amount = exposure === null ? null : autonomyDecimal(exposure),
      spent = autonomyDecimal(usage.exposure),
      moneyLimit = autonomyDecimal(policy.scope.money.daily);
    if (
      amount === null ||
      spent === null ||
      moneyLimit === null ||
      spent + amount > moneyLimit
    )
      throw conflict(
        'The scoped daily exposure limit is exhausted or unknown. No action was dispatched.',
      );
  }
  await tx.query(
    'INSERT INTO autonomy_reservations(tenant_id,proposal_id,policy_id,policy_revision,budget_day,quantity,exposure,document) VALUES($1,$2,$3,$4,$5::date,$6::numeric,$7::numeric,$8)',
    [
      tenantId,
      proposalId,
      policy.id,
      policy.revision,
      day,
      admission.facts.quantity,
      policy.scope.money ? exposure : null,
      admission,
    ],
  );
}

/** Records real verification and pauses/demotes on failed checks, uncertain writes or unavailable evidence. */
export async function completeAutonomy(
  tx: SqlTransaction,
  tenantId: string,
  proposalId: string,
  admission: AutonomyAdmission,
  result: {
    dispatch: 'not_dispatched' | 'dispatched' | 'uncertain';
    verification: 'passed' | 'failed' | 'unknown' | 'not_checked';
  },
  now: Date,
) {
  await fence(tx, tenantId);
  await tx.query(
    "UPDATE autonomy_history SET document=jsonb_set(jsonb_set(document,'{verification}',to_jsonb($3::text)),'{dispatch}',to_jsonb($4::text)),updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2",
    [tenantId, proposalId, result.verification, result.dispatch],
  );
  if (result.dispatch === 'not_dispatched') return;
  const reason =
    result.dispatch === 'uncertain'
      ? 'uncertain_dispatch'
      : result.verification === 'failed'
        ? 'verification_failed'
        : result.verification === 'unknown'
          ? 'evidence_unavailable'
          : null;
  if (!reason) return;
  const policy = (
    await tx.query<{ document: ScopedAutonomyPolicy }>(
      'SELECT document FROM autonomy_policies WHERE tenant_id=$1 AND id=$2',
      [tenantId, admission.policyId],
    )
  ).rows[0]?.document;
  if (!policy || policy.revoked || policy.paused) return;
  const next: ScopedAutonomyPolicy = {
    ...policy,
    revision: policy.revision + 1,
    mode: policy.mode === 'autonomous' ? 'assisted' : 'manual',
    paused: true,
    circuitReason: reason,
    updatedAt: now.toISOString(),
    updatedBy: 'scoped-autonomy-circuit',
  };
  await persistRevision(tx, next, {
    id: randomUUID(),
    tenantId,
    policyId: policy.id,
    revision: next.revision,
    actorId: 'scoped-autonomy-circuit',
    correlationId: proposalId,
    at: next.updatedAt,
    previousMode: policy.mode,
    mode: next.mode,
    reason,
  });
}
