import type { nativeShipmentReadSchema, OrderDetail } from '@luma/api-contract';
import {
  formatExactQuantity,
  formatNumber,
  parseExactQuantityInput,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { quantityWithUnit } from '@luma/ui/lib/units';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Ellipsis, PackageCheck } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';

import { contextOptions } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { OrderSection } from '../../shared/orders/order-section';
import { inventoryOptions } from '../inventory/data';

const api = createWebApiClient();

/**
 * Shows the stock Luma holds for the order and, for stock managers, reads shipments, consumes
 * shipped units, releases holds and reserves stock. Independent shipment reads stay separate
 * from physical consumption. Orders whose stock Luma doesn't keep show nothing.
 */
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
  const [reserving, setReserving] = useState(false);
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
  const reservations = query.data?.reservations ?? [];
  // Orders whose stock Luma doesn't keep have neither demand nor holds, so there is nothing to show.
  if (query.isPending || (!query.isError && !demand && !reservations.length))
    return null;
  const busy = read.isPending || operate.isPending;
  const canReserve = manage && demand?.status === 'open' && editable;
  const lineLabel = (lineId: string) =>
    demand?.lines.find((line) => line.id === lineId)?.skuCode ??
    detail.sources
      .flatMap((source) => source.lines)
      .find((line) => line.id === lineId)?.skuCode ??
    m.common_not_reported();
  const quantityLabel = (value: string, unit: string) =>
    quantityWithUnit(formatExactQuantity(value), unit, value);
  const notices = [
    query.isError ? (
      <Alert key="unavailable" tone="warning">
        {m.inventory_native_stock_unavailable()}{' '}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    ) : null,
    proof ? (
      <p key="proof" role="status" className="order-note">
        {m.inventory_native_stock_proof()}{' '}
        <WorkspaceDate value={proof.observedAt} />
      </p>
    ) : null,
    shortage !== null ? (
      <Alert key="shortage" role="status">
        {m.inventory_native_stock_shortage({ quantity: shortage })}
      </Alert>
    ) : null,
    expiryResult ? (
      <Alert key="expiry" role="status">
        {m.inventory_native_stock_expiry_result({
          released: formatNumber(expiryResult.released),
          blocked: formatNumber(expiryResult.blocked),
        })}
      </Alert>
    ) : null,
    read.error || operate.error ? (
      <Alert key="error" tone="warning" role="alert">
        {(read.error ?? operate.error)?.message}
      </Alert>
    ) : null,
  ].filter(Boolean);

  return (
    <>
      <OrderSection
        title={m.orders_stock_title()}
        icon={PackageCheck}
        description={
          reservations.length ? m.orders_stock_description() : undefined
        }
        status={
          reservations.length || query.isError ? null : (
            <Badge>{m.orders_section_none()}</Badge>
          )
        }
        action={
          manage && connectionId ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.orders_stock_actions()}
                    title={m.orders_stock_actions()}
                  >
                    <Ellipsis aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-auto min-w-64">
                <DropdownMenuItem disabled={busy} onClick={() => read.mutate()}>
                  {m.inventory_native_stock_shipments()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!proof || busy || !reservations.length}
                  onClick={() => operate.mutate({ kind: 'consume' })}
                >
                  {m.inventory_native_stock_consume()}
                </DropdownMenuItem>
                {canReserve ? (
                  <DropdownMenuItem onClick={() => setReserving(true)}>
                    {m.orders_stock_reserve_open()}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={operate.isPending}
                  onClick={() => operate.mutate({ kind: 'expiry' })}
                >
                  {m.inventory_native_stock_expiry()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      >
        {reservations.length || notices.length ? (
          <div className="order-stock">
            {reservations.length ? (
              <DataTable
                caption={m.orders_stock_caption()}
                rows={reservations}
                rowKey={(value) => value.id}
                density="compact"
                columns={[
                  {
                    key: 'line',
                    header: m.inventory_native_stock_line(),
                    cell: (value) => (
                      <span className="orders-cell-stack">
                        <span>{lineLabel(value.orderLineId)}</span>
                        <small>
                          <Link
                            to="/app/$organizationId/inventory"
                            params={{ organizationId }}
                            search={{
                              skuId: value.skuId,
                              locationId: value.locationId,
                            }}
                          >
                            {detail.fulfillments.find(
                              (fulfillment) =>
                                fulfillment.location?.locationId ===
                                value.locationId,
                            )?.location?.name ??
                              m.inventory_native_stock_location()}
                          </Link>
                        </small>
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: m.orders_stock_column_status(),
                    cell: (value) => (
                      <span className="orders-cell-stack">
                        <span className="order-stock-status">
                          {value.state === 'active'
                            ? m.inventory_native_stock_reserved()
                            : value.state === 'consumed'
                              ? m.inventory_native_stock_consumed()
                              : value.state === 'expired'
                                ? m.inventory_native_stock_expired()
                                : m.inventory_native_stock_released()}
                        </span>
                        {value.state === 'active' && value.expiresAt ? (
                          <small>
                            {rich(m.orders_stock_expires_note, {
                              date: <WorkspaceDate value={value.expiresAt} />,
                            })}
                          </small>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: 'remaining',
                    header: m.inventory_native_stock_remaining(),
                    numeric: true,
                    cell: (value) => {
                      const notes = [
                        Number(value.consumed) > 0
                          ? m.orders_stock_consumed_note({
                              quantity: quantityLabel(
                                value.consumed,
                                value.unit,
                              ),
                            })
                          : null,
                        Number(value.released) > 0
                          ? m.orders_stock_released_note({
                              quantity: quantityLabel(
                                value.released,
                                value.unit,
                              ),
                            })
                          : null,
                      ].filter((note) => note !== null);

                      return (
                        <span className="orders-cell-stack">
                          <span>
                            {quantityLabel(value.remaining, value.unit)}
                          </span>
                          {notes.map((note) => (
                            <small key={note}>{note}</small>
                          ))}
                        </span>
                      );
                    },
                  },
                  ...(manage
                    ? [
                        {
                          key: 'actions',
                          header: (
                            <span className="sr-only">
                              {m.orders_lines_column_actions()}
                            </span>
                          ),
                          cell: (value: (typeof reservations)[number]) =>
                            value.state === 'active' ? (
                              <span className="order-line-menu">
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    render={
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={m.orders_stock_row_actions({
                                          line: lineLabel(value.orderLineId),
                                        })}
                                      >
                                        <Ellipsis aria-hidden="true" />
                                      </Button>
                                    }
                                  />
                                  <DropdownMenuContent
                                    align="end"
                                    className="w-auto min-w-56"
                                  >
                                    <DropdownMenuItem
                                      disabled={!proof || operate.isPending}
                                      onClick={() =>
                                        operate.mutate({
                                          kind: 'release',
                                          id: value.id,
                                        })
                                      }
                                    >
                                      {m.inventory_native_stock_release()}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </span>
                            ) : null,
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
            {manage && reservations.length && !proof ? (
              <p className="order-note">{m.orders_stock_read_first()}</p>
            ) : null}
            {notices}
          </div>
        ) : null}
      </OrderSection>
      {canReserve && demand ? (
        <Dialog open={reserving} onOpenChange={setReserving}>
          <DialogContent className="order-stock-dialog">
            <DialogHeader>
              <DialogTitle>{m.inventory_native_stock_allocate()}</DialogTitle>
              <DialogDescription>
                {m.inventory_native_stock_reservations_note()}
              </DialogDescription>
            </DialogHeader>
            <form
              className="native-stock-form"
              onSubmit={(event) => {
                event.preventDefault();
                operate.mutate(
                  { kind: 'allocate' },
                  { onSuccess: () => setReserving(false) },
                );
              }}
            >
              {proof ? (
                <p className="order-note">
                  {m.inventory_native_stock_proof()}{' '}
                  <WorkspaceDate value={proof.observedAt} />
                </p>
              ) : (
                <div className="order-stock-read">
                  <p className="order-note">{m.orders_stock_read_first()}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => read.mutate()}
                  >
                    {m.inventory_native_stock_shipments()}
                  </Button>
                </div>
              )}
              <fieldset disabled={busy}>
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
                  <p className="order-note">
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
                {operate.error ? (
                  <Alert tone="warning" role="alert">
                    {operate.error.message}
                  </Alert>
                ) : null}
              </fieldset>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !proof ||
                    !pool.data?.opened ||
                    pool.data.scope.mode === 'observe'
                  }
                >
                  {m.inventory_native_stock_allocate()}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
