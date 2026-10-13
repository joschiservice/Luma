import type { nativeShipmentReadSchema, OrderDetail } from '@luma/api-contract';
import {
  formatExactQuantity,
  formatNumber,
  parseExactQuantityInput,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { unitOfMeasure } from '@luma/ui/lib/units';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';

import { contextOptions } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { inventoryOptions } from '../inventory/data';

const api = createWebApiClient();

/** Inspects exact remaining order holds and keeps independent reads separate from physical consumption. */
export function NativeOrderStock({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: OrderDetail;
}) {
  const identity = useQuery(contextOptions(organizationId));
  if (!identity.data?.permissions.includes('inventory.read')) return null;

  return <OrderStockControls organizationId={organizationId} detail={detail} />;
}

function OrderStockControls({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: OrderDetail;
}) {
  const orderId = detail.order.id,
    params = { organizationId, orderId };
  const client = useQueryClient(),
    identity = useQuery(contextOptions(organizationId));
  const manage =
    !!identity.data?.permissions.includes('inventory.manage') &&
    !identity.data.supportView;
  const connectionId = detail.sources.find(
    (source) => source.system === 'shopify',
  )?.connectionId;
  const query = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'orders',
      'native',
      orderId,
    ],
    refetchInterval: 60_000,
    queryFn: ({ signal }) => api.nativeStock.order({ params }, { signal }),
  });
  const [proof, setProof] = useState<z.infer<
    typeof nativeShipmentReadSchema
  > | null>(null);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const [quantity, setQuantity] = useState('1'),
    [lineId, setLineId] = useState(''),
    [locationId, setLocationId] = useState('');
  const [shortage, setShortage] = useState<string | null>(null),
    [expiryResult, setExpiryResult] = useState<{
      released: number;
      blocked: number;
    } | null>(null);
  const demand = query.data?.demand;
  const line = demand?.lines.find((value) => value.id === lineId);
  const editable =
    !!demand &&
    ['order_lines', 'order_lifecycle'].every((group) =>
      detail.authority.groups.some(
        (fact) =>
          fact.group === group &&
          fact.connectionId === demand.connectionId &&
          fact.state === 'resolved' &&
          fact.basis === 'override',
      ),
    );
  const locations = useQuery({
    ...inventoryOptions(organizationId, {
      skuId: line?.skuId ?? undefined,
      connectionId,
    }),
    enabled: !!line?.skuId && !!connectionId,
  });
  const pool = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'inventory',
      'native',
      line?.skuId,
      locationId,
      connectionId,
      line?.unit,
    ],
    enabled: !!line?.skuId && !!locationId && !!connectionId,
    queryFn: ({ signal }) =>
      api.nativeStock.pool(
        {
          params: {
            organizationId,
            skuId: line!.skuId!,
            locationId,
            connectionId: connectionId!,
          },
          query: { unit: line!.unit },
        },
        { signal },
      ),
  });
  const changed = async () => {
    await client.invalidateQueries({
      queryKey: ['private', 'organization', organizationId],
    });
  };
  const read = useMutation({
    mutationFn: async () => {
      if (!connectionId)
        throw new Error(m.inventory_native_stock_unavailable());
      setProof(
        await api.nativeStock.shipments({ params, body: { connectionId } }),
      );
    },
  });
  const operate = useMutation({
    mutationFn: async (
      action:
        | { kind: 'allocate' }
        | { kind: 'consume' }
        | { kind: 'release'; id: string }
        | { kind: 'expiry' },
    ) => {
      const id = commandId;
      if (action.kind === 'expiry') {
        const result = await api.nativeStock.expire({
          params: { organizationId },
          body: { limit: 100, orderId },
        });
        setExpiryResult({
          released: result.released.length,
          blocked: result.blocked.length,
        });

        return;
      }
      if (!proof || !query.data)
        throw new Error(m.inventory_native_stock_reservations_note());
      if (action.kind === 'consume')
        await api.nativeStock.consume({
          params: { organizationId },
          body: {
            id,
            key: id,
            orderId,
            shipmentReadId: proof.id,
            expected: query.data.reservations
              .filter((value) => value.state === 'active')
              .map((value) => ({ id: value.id, version: value.version })),
          },
        });
      else if (action.kind === 'release') {
        const reservation = query.data.reservations.find(
          (value) => value.id === action.id,
        );
        if (!reservation)
          throw new Error(m.inventory_native_stock_unavailable());
        await api.nativeStock.release({
          params: { organizationId },
          body: {
            id,
            key: id,
            reservationId: reservation.id,
            version: reservation.version,
            quantity: reservation.remaining,
            reason: 'release',
            shipmentReadId: proof.id,
          },
        });
      } else {
        const available = pool.data?.accounts.find(
          (account) => account.address.state === 'available',
        );
        if (!available || !line || !demand || !connectionId || !pool.data)
          throw new Error(m.inventory_native_stock_unavailable());
        const parsedQuantity = parseExactQuantityInput(quantity);
        if (parsedQuantity === null)
          throw new Error(m.inventory_native_stock_quantity_invalid());
        const result = await api.nativeStock.allocate({
          params: { organizationId },
          body: {
            id,
            key: id,
            reservationId:
              query.data.reservations.find(
                (value) =>
                  value.state === 'active' &&
                  value.orderLineId === line.id &&
                  value.locationId === locationId,
              )?.id ?? id,
            orderId,
            orderLineId: line.id,
            orderVersion: demand.version,
            connectionId,
            locationId,
            quantity: parsedQuantity,
            unit: line.unit,
            expiresAt:
              query.data.reservations.find(
                (value) =>
                  value.state === 'active' &&
                  value.orderLineId === line.id &&
                  value.locationId === locationId,
              )?.expiresAt ?? null,
            reservationVersion:
              query.data.reservations.find(
                (value) =>
                  value.state === 'active' &&
                  value.orderLineId === line.id &&
                  value.locationId === locationId,
              )?.version ?? null,
            available: {
              balance: available.balance,
              version: available.version,
            },
            ownershipVersion: pool.data.scope.version,
            authorityRevision: pool.data.scope.authorityRevision,
            shipmentReadId: proof.id,
          },
        });
        setShortage(formatExactQuantity(result.unallocated));
      }
    },
    onSuccess: async () => {
      setCommandId(crypto.randomUUID());
      await changed();
    },
  });
  const locationOptions = Array.from(
    new Map(
      (locations.data?.items ?? [])
        .filter((value) => value.unit === line?.unit)
        .map((value) => [
          value.locationId,
          { value: value.locationId, label: value.location },
        ]),
    ).values(),
  );

  return (
    <Card className="inventory-section">
      <h2>{m.inventory_native_stock_reservations_title()}</h2>
      <p>{m.inventory_native_stock_reservations_note()}</p>
      {query.isPending ? (
        <p role="status">{m.inventory_native_stock_loading()}</p>
      ) : query.isError ? (
        <Alert tone="warning">
          {m.inventory_native_stock_unavailable()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : query.data?.reservations.length ? (
        <DataTable
          caption={m.inventory_native_stock_reservations_title()}
          rows={query.data.reservations}
          rowKey={(value) => value.id}
          columns={[
            {
              key: 'line',
              header: m.inventory_native_stock_line(),
              cell: (value) =>
                demand?.lines.find((line) => line.id === value.orderLineId)
                  ?.skuCode ??
                detail.sources
                  .flatMap((source) => source.lines)
                  .find((line) => line.id === value.orderLineId)?.skuCode ??
                m.common_not_reported(),
            },
            {
              key: 'location',
              header: m.inventory_native_stock_location(),
              cell: (value) => (
                <Link
                  to="/app/$organizationId/inventory"
                  params={{ organizationId }}
                  search={{ skuId: value.skuId, locationId: value.locationId }}
                >
                  {detail.fulfillments.find(
                    (fulfillment) =>
                      fulfillment.location?.locationId === value.locationId,
                  )?.location?.name ?? m.inventory_native_stock_location()}
                </Link>
              ),
            },
            {
              key: 'unit',
              header: m.inventory_native_stock_unit(),
              cell: (value) => unitOfMeasure(value.unit),
            },
            {
              key: 'status',
              header: m.inventory_native_stock_status(),
              cell: (value) =>
                value.state === 'active'
                  ? m.inventory_native_stock_reserved()
                  : value.state === 'consumed'
                    ? m.inventory_native_stock_consumed()
                    : value.state === 'expired'
                      ? m.inventory_native_stock_expired()
                      : m.inventory_native_stock_released(),
            },
            {
              key: 'remaining',
              header: m.inventory_native_stock_remaining(),
              numeric: true,
              cell: (value) => formatExactQuantity(value.remaining),
            },
            {
              key: 'consumed',
              header: m.inventory_native_stock_consumed(),
              numeric: true,
              cell: (value) => formatExactQuantity(value.consumed),
            },
            {
              key: 'released',
              header: m.inventory_native_stock_released(),
              numeric: true,
              cell: (value) => formatExactQuantity(value.released),
            },
            {
              key: 'expires',
              header: m.inventory_native_stock_expires(),
              cell: (value) =>
                value.expiresAt ? (
                  <WorkspaceDate value={value.expiresAt} />
                ) : (
                  m.common_empty_value()
                ),
            },
            {
              key: 'release',
              header: m.inventory_native_stock_release(),
              cell: (value) =>
                manage && value.state === 'active' ? (
                  <Button
                    variant="outline"
                    disabled={!proof || operate.isPending}
                    onClick={() =>
                      operate.mutate({ kind: 'release', id: value.id })
                    }
                  >
                    {m.inventory_native_stock_release()}
                  </Button>
                ) : (
                  m.common_empty_value()
                ),
            },
          ]}
        />
      ) : (
        <p>{m.inventory_native_stock_reservations_empty()}</p>
      )}
      {manage && connectionId ? (
        <>
          <div className="inventory-record-links">
            <Button
              variant="outline"
              disabled={read.isPending || operate.isPending}
              onClick={() => read.mutate()}
            >
              {m.inventory_native_stock_shipments()}
            </Button>
            <Button
              disabled={!proof || operate.isPending || read.isPending}
              onClick={() => operate.mutate({ kind: 'consume' })}
            >
              {m.inventory_native_stock_consume()}
            </Button>
            <Button
              variant="outline"
              disabled={operate.isPending}
              onClick={() => operate.mutate({ kind: 'expiry' })}
            >
              {m.inventory_native_stock_expiry()}
            </Button>
          </div>
          {proof ? (
            <Alert role="status">
              {m.inventory_native_stock_proof()}{' '}
              <WorkspaceDate value={proof.observedAt} />
            </Alert>
          ) : null}
          {demand?.status === 'open' && editable ? (
            <form
              className="native-stock-form"
              onSubmit={(event) => {
                event.preventDefault();
                operate.mutate({ kind: 'allocate' });
              }}
            >
              <fieldset disabled={operate.isPending || read.isPending}>
                <label>
                  {m.inventory_native_stock_line()}
                  <Select
                    value={lineId}
                    onValueChange={(value) => {
                      setLineId(value ?? '');
                      setLocationId('');
                    }}
                    options={demand.lines
                      .filter((value) => !!value.skuId)
                      .map((value) => ({
                        value: value.id,
                        label: `${value.skuCode ?? value.id} · ${formatExactQuantity(value.currentQuantity)}`,
                      }))}
                  />
                </label>
                <label>
                  {m.inventory_native_stock_location()}
                  <Select
                    value={locationId}
                    onValueChange={(value) => setLocationId(value ?? '')}
                    options={locationOptions}
                  />
                </label>
                <label>
                  {m.inventory_native_stock_quantity()}
                  <Input
                    inputMode="decimal"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    required
                  />
                </label>
                {pool.data ? (
                  <p>
                    {m.inventory_native_stock_available()}:{' '}
                    {pool.data.opened
                      ? formatExactQuantity(
                          pool.data.accounts.find(
                            (account) => account.address.state === 'available',
                          )?.balance ?? '0',
                        )
                      : m.inventory_native_stock_unopened()}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    !proof ||
                    !pool.data?.opened ||
                    pool.data.scope.mode === 'observe'
                  }
                >
                  {m.inventory_native_stock_allocate()}
                </Button>
              </fieldset>
            </form>
          ) : null}
        </>
      ) : null}
      {shortage !== null ? (
        <Alert role="status">
          {m.inventory_native_stock_shortage({ quantity: shortage })}
        </Alert>
      ) : null}
      {expiryResult ? (
        <Alert role="status">
          {m.inventory_native_stock_expiry_result({
            released: formatNumber(expiryResult.released),
            blocked: formatNumber(expiryResult.blocked),
          })}
        </Alert>
      ) : null}
      {read.error || operate.error ? (
        <Alert tone="warning" role="alert">
          {(read.error ?? operate.error)?.message}
        </Alert>
      ) : null}
    </Card>
  );
}
