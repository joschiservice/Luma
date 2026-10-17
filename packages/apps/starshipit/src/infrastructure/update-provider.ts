import { randomUUID } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { ConnectorError, type InstallationService } from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import { createClient, parse } from '@luma/connector-starshipit';
import * as s from '@luma/connector-starshipit/schemas';
import type { TenantContext } from '@luma/identity';
import { notFound } from '@luma/platform';

import { installationCredentials } from '../domain/installation-validation.js';
import { revision } from './mapping.js';
import type { createUpdateStore } from './update-store.js';

/**
 * Identifies the normalization of order update reads and acceptances; execution pins it in the
 * update's dispatch identity.
 */
export const updateAdapterVersion = 'starshipit-update/1';

/** Refreshes tenant-bound credentials per request and persists allowlisted independent reads. */
export function createUpdateProvider(
  context: AppFactoryContext,
  installations: InstallationService,
  store: Pick<ReturnType<typeof createUpdateStore>, 'record'>,
) {
  async function provider(
    tenant: TenantContext,
    connectionId: string,
    write = false,
  ) {
    const installedVersion = await context.requireInstalled(
      tenant,
      'starshipit',
    );
    const current = await installations.credential(
      tenant,
      connectionId,
      write ? 'orders.quantity.update' : 'orders.read',
    );
    if (
      current.connection.appId !== 'starshipit' ||
      current.connection.target.kind !== 'starshipit' ||
      current.connection.appInstallationVersion !== installedVersion
    )
      throw notFound('Starshipit connection not found.');
    const fetch = simulationTransport(current.connection, context.simulation);

    return createClient({
      ...(fetch ? { fetch } : {}),
      credentials: async () => {
        await installations.credential(
          tenant,
          connectionId,
          'fulfillment.read',
        );
        const fresh = await installations.credential(
          tenant,
          connectionId,
          write ? 'orders.quantity.update' : 'orders.read',
        );
        if (
          fresh.connection.credentialVersion !==
          current.connection.credentialVersion
        )
          throw new ConnectorError({
            code: 'conflict',
            effect: 'none',
            retry: 'never',
          });

        return installationCredentials.parse(fresh.credentials);
      },
    });
  }

  async function read(
    tenant: TenantContext,
    target: { connectionId: string; orderId: string },
  ) {
    const observedAt = new Date().toISOString();
    const client = await provider(tenant, target.connectionId);
    const order = parse(
      s.detail,
      await client.read(
        'orders',
        new URLSearchParams({ order_id: target.orderId }),
      ),
    ).order;
    if (
      order.order_id !== target.orderId ||
      new Set(order.items.map((item) => item.item_id)).size !==
        order.items.length
    )
      throw new ConnectorError({
        code: 'invalid_response',
        effect: 'none',
        retry: 'never',
      });
    const id = randomUUID();
    const digest = revision(order);
    // One order detail is the whole read: a response cut short fails parsing instead of being
    // stored. Starshipit reports no order update time, so the revision is Luma's fingerprint.
    await store.record(tenant, id, target.connectionId, observedAt, {
      kind: 'observation',
      orderId: order.order_id,
      revision: digest,
      status: order.status ?? order.order_status,
      lines: order.items.map((line) => ({
        id: line.item_id,
        quantity: line.quantity,
      })),
      adapterVersion: updateAdapterVersion,
      completeness: 'complete',
      sourceUpdatedAt: null,
    });

    return { id, observedAt, order, revision: digest };
  }

  return { provider, read };
}
