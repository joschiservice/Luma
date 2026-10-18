import { createHash, randomUUID } from 'node:crypto';

import type { AuditEntry, AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { requireChangesAllowed, requirePermission } from '@luma/identity';
import { conflict, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CustomerErasure,
  CustomerErasureResult,
} from '../application/erasure.js';

const targetSchema = z
  .object({
    connectionId: z.string().uuid(),
    externalId: z.string().trim().min(1).max(1024),
    emails: z.array(z.string().trim().toLowerCase().email().max(320)).max(20),
  })
  .strict();

const requestSchema = targetSchema.extend({ id: z.string().uuid() }).strict();

const counts = [
  'profiles',
  'messages',
  'threads',
  'replies',
  'rules',
] as const satisfies readonly (keyof CustomerErasureResult)[];

const eraseSql =
  'SELECT erase_customer($1::uuid,$2::text,$3::text[]) AS result';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Erases customers through `erase_customer`, which takes the tenant from the transaction. The
 * audit entry shares the transaction and names the connection and a digest of the command, never
 * the customer's ID or addresses.
 */
export function createCustomerErasure(deps: {
  db: TenantDatabase;
  audit: (db: TenantDatabase) => AuditLog;
  refreshContext: (context: TenantContext) => Promise<TenantContext>;
  now?: () => Date;
}): CustomerErasure {
  const now = deps.now ?? (() => new Date());

  return {
    async preview(context, target) {
      const input = targetSchema.parse(target);
      const fresh = await deps.refreshContext(context);
      requirePermission(fresh, 'customers.erase');

      // Runs the erasure itself and rolls it back, so the preview counts exactly what erasing
      // would. It holds the connection's customer lock until the transaction ends.
      return deps.db.transaction(fresh.tenantId, async (tx) => {
        await tx.query('SAVEPOINT erasure_preview');
        const row = (
          await tx.query<{ result: CustomerErasureResult | null }>(eraseSql, [
            input.connectionId,
            input.externalId,
            input.emails,
          ])
        ).rows[0];
        await tx.query('ROLLBACK TO SAVEPOINT erasure_preview');

        return row?.result ?? null;
      });
    },
    async erase(context, request) {
      const input = requestSchema.parse(request);
      const fresh = await deps.refreshContext(context);
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'customers.erase');
      // The customer ID is what the erasure must forget; the hash only detects a reused command.
      const actionHash = digest(
        JSON.stringify([input.connectionId, digest(input.externalId)]),
      );

      return deps.db.transaction(fresh.tenantId, async (tx) => {
        const audit = deps.audit({ transaction: async (_t, fn) => fn(tx) });
        const previous = (await audit.list(fresh.tenantId, input.id)).find(
          (entry) => entry.eventType === 'customers.erased',
        );
        if (previous) {
          if (previous.actionHash !== actionHash)
            throw conflict(
              'This erasure ID was already used for another customer',
            );

          const count = (key: (typeof counts)[number]) =>
            Number(previous.details[key] ?? 0);

          return {
            profiles: count('profiles'),
            messages: count('messages'),
            threads: count('threads'),
            replies: count('replies'),
            rules: count('rules'),
          };
        }
        const row = (
          await tx.query<{ result: CustomerErasureResult | null }>(eraseSql, [
            input.connectionId,
            input.externalId,
            input.emails,
          ])
        ).rows[0];
        const result = row?.result ?? null;
        if (!result) return null;
        const entry: AuditEntry = {
          id: randomUUID(),
          tenantId: fresh.tenantId,
          eventKey: `customers:erased:${input.id}`,
          eventType: 'customers.erased',
          schemaVersion: 1,
          occurredAt: now().toISOString(),
          actor: { kind: 'user', id: fresh.actor.id },
          correlationId: fresh.requestId,
          proposalId: input.id,
          actionHash,
          connectionId: input.connectionId,
          evidenceRefs: [],
          details: {
            commandId: input.id,
            source: 'member',
            scope: 'customer',
            ...Object.fromEntries(
              counts.map((key) => [key, String(result[key])]),
            ),
            addresses: String(input.emails.length),
          },
        };
        await audit.append(entry);

        return result;
      });
    },
  };
}
