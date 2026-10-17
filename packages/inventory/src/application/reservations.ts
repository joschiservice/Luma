import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { forbidden, notFound } from '@luma/platform';

import {
  decimalQuantity,
  LedgerError,
  nextStockVersion,
  quantityUnits,
} from '../domain/ledger.js';
import { requireAllocationMode } from '../domain/ownership.js';
import {
  allocationQuantity,
  consumeReservation,
  releaseReservation,
  type StockReservation,
} from '../domain/reservations.js';
import type {
  AllocationInput,
  ConsumptionResult,
  NativeStockDependencies,
  NativeStockTransaction,
  ReleaseInput,
  ReservationResult,
  ShipmentRead,
} from './native-stock.js';
import { reservationAddress, reservationMovement } from './native-stock.js';

/** Creates native allocations and bounded releases; no provider mutation or fulfillment preparation is exposed. */
export function createReservationService(deps: NativeStockDependencies) {
  const now = deps.now ?? (() => new Date());

  async function access(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id) throw forbidden('Actor changed');
    requirePermission(fresh, 'inventory.read');
    requirePermission(fresh, 'inventory.manage');
    requirePermission(fresh, 'orders.read');
    requireChangesAllowed(fresh);

    return fresh;
  }

  function freshProof(
    proof: ShipmentRead | null,
    orderId: string,
    connectionId: string,
  ): asserts proof is ShipmentRead {
    if (
      !proof ||
      !proof.complete ||
      proof.orderId !== orderId ||
      proof.connectionId !== connectionId ||
      new Set(proof.shipments.map((shipment) => shipment.id)).size !==
        proof.shipments.length ||
      proof.shipments.some(
        (shipment) =>
          new Set(shipment.lines.map((line) => line.orderLineId)).size !==
            shipment.lines.length ||
          shipment.status === 'unknown' ||
          shipment.status === 'pending' ||
          ((shipment.status === 'shipped' || shipment.status === 'delivered') &&
            shipment.locationId === null),
      )
    )
      throw new LedgerError(
        'source_incomplete',
        'Read complete, settled shipment evidence for this order and source.',
      );
    const age = now().getTime() - Date.parse(proof.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 300_000)
      throw new LedgerError(
        'evidence_stale',
        'Read shipments again before changing stock reservations.',
      );
  }

  async function release(
    tx: NativeStockTransaction,
    input: ReleaseInput,
  ): Promise<ReservationResult> {
    const hash = deps.hash(input);
    await tx.ledger.lockCommand(input.key);
    const previous = await tx.reservationReceipt(input.key, hash);
    if (previous) return previous;
    const initial = await tx.reservation(input.reservationId, false);
    if (!initial) throw notFound('Stock reservation not found');
    await tx.lockOrder(initial.orderId);
    const demand = await tx.demand(initial.orderId, false);
    const value = await tx.reservation(initial.id, true);
    if (!value || value.version !== input.version)
      throw new LedgerError('stale', 'This reservation changed.');
    const proof = await tx.shipmentRead(input.shipmentReadId);
    freshProof(
      proof,
      value.orderId,
      (await tx.scope(null, value.locationId, false)).connectionId,
    );
    if (await tx.unsettled(proof.connectionId, value.locationId, value.orderId))
      throw new LedgerError(
        'review_required',
        'Verify in-flight effects before releasing stock.',
      );
    // New shipment evidence must be consumed first; cancellation cannot free units already known to have left.
    for (const shipment of proof.shipments.filter(
      (shipment) =>
        shipment.status === 'shipped' || shipment.status === 'delivered',
    )) {
      const line = shipment.lines.find(
        (line) =>
          line.orderLineId === value.orderLineId && line.unit === value.unit,
      );
      if (
        line &&
        shipment.locationId === value.locationId &&
        quantityUnits(line.quantity) >
          quantityUnits(
            await tx.shipmentClaim(
              proof.connectionId,
              shipment.id,
              value.orderLineId,
            ),
          )
      )
        throw new LedgerError(
          'review_required',
          'Apply verified shipment consumption before releasing this reservation.',
        );
    }
    const changed = releaseReservation(
      value,
      input.quantity,
      input.reason,
      now().toISOString(),
    );
    const locked = await tx.ledger.accounts(
      [
        reservationAddress(value, 'available'),
        reservationAddress(value, 'reserved'),
      ],
      true,
    );
    const from = locked.find(
        (account) => account.address.state === 'reserved',
      )!,
      to = locked.find((account) => account.address.state === 'available')!;
    const command = reservationMovement(
      {
        id: input.id,
        key: input.key,
        reason: `Native reservation ${input.reason}`,
        effectiveAt: now().toISOString(),
        purpose: 'release',
        evidence: [],
      },
      from,
      to,
      decimalQuantity(quantityUnits(input.quantity)),
    );
    const ledger = await tx.ledger.commit(
      command,
      deps.hash(command),
      locked,
      null,
    );
    await tx.saveReservation(changed, value.version);
    const result: ReservationResult = {
      key: input.key,
      commandHash: hash,
      reservation: changed,
      allocated: '0',
      unallocated: '0',
      ledger,
      orderVersion: demand?.version ?? 0,
    };
    await tx.rememberReservation(result);
    await tx.audit(input.id, input.key, 'released', {
      reservationId: value.id,
      reason: input.reason,
    });

    return result;
  }

  return {
    /** Releases due remaining holds in a bounded sweep; stale or uncertain evidence leaves the hold intact for attention. */
    async expireDue(context: TenantContext, limit = 100, orderId?: string) {
      const fresh = await access(context);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new LedgerError(
          'invalid_entry',
          'Expire between one and 200 holds at a time.',
        );
      const due = await deps.store.transaction(fresh, (tx) =>
          tx.dueReservations(now().toISOString(), limit, orderId),
        ),
        released: string[] = [],
        blocked: { id: string; code: string }[] = [];
      for (const value of due) {
        try {
          await deps.store.transaction(fresh, async (tx) => {
            const scope = await tx.scope(null, value.locationId, false),
              proof = await tx.latestShipmentRead(
                value.orderId,
                scope.connectionId,
              );
            freshProof(proof, value.orderId, scope.connectionId);
            const seed = deps.hash([
              'expiry',
              fresh.tenantId,
              value.id,
              value.version,
            ]);
            const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-5${seed.slice(13, 16)}-${((parseInt(seed.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${seed.slice(18, 20)}-${seed.slice(20, 32)}`;
            await release(tx, {
              id,
              key: `native-expiry:${id}`,
              reservationId: value.id,
              version: value.version,
              quantity: value.remaining,
              reason: 'expiry',
              shipmentReadId: proof.id,
            });
          });
          released.push(value.id);
        } catch (error) {
          if (!(error instanceof LedgerError)) throw error;
          blocked.push({ id: value.id, code: error.code });
        }
      }

      return { released, blocked, hasMore: due.length === limit };
    },
    /** Sales supplies an admitted reduction inside its transaction; stock release and the order update either both commit or both roll back. */
    async reconcileDemand(
      context: TenantContext,
      input: {
        commandId: string;
        orderId: string;
        status: 'open' | 'completed' | 'cancelled';
        lines: { id: string; currentQuantity: string }[];
      },
    ) {
      return deps.store.transaction(context, async (tx) => {
        await tx.lockOrder(input.orderId);
        const reservations = (
          await tx.reservations(input.orderId, true)
        ).filter((value) => value.state === 'active');
        if (!reservations.length) return;
        await access(context);
        for (const line of input.lines) {
          const affected = reservations.filter(
              (value) => value.orderLineId === line.id,
            ),
            proofs = new Map<string, ShipmentRead>();
          for (const value of affected) {
            const scope = await tx.scope(null, value.locationId, false);
            const proof = await tx.latestShipmentRead(
              input.orderId,
              scope.connectionId,
            );
            freshProof(proof, input.orderId, scope.connectionId);
            proofs.set(scope.connectionId, proof);
          }
          if (!affected.length) continue;
          const shipped = [...proofs.values()]
            .map((proof) =>
              proof.shipments
                .filter(
                  (shipment) =>
                    shipment.status === 'shipped' ||
                    shipment.status === 'delivered',
                )
                .flatMap((shipment) => shipment.lines)
                .filter((value) => value.orderLineId === line.id)
                .reduce(
                  (sum, value) => sum + quantityUnits(value.quantity),
                  0n,
                ),
            )
            .reduce(
              (maximum, value) => (value > maximum ? value : maximum),
              0n,
            );
          const wanted =
              input.status === 'cancelled'
                ? 0n
                : quantityUnits(line.currentQuantity),
            allowed = wanted > shipped ? wanted - shipped : 0n;
          let excess =
            affected.reduce(
              (sum, value) => sum + quantityUnits(value.remaining),
              0n,
            ) - allowed;
          for (const value of affected.sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          )) {
            if (excess <= 0n) break;
            const scope = await tx.scope(null, value.locationId, false),
              proof = proofs.get(scope.connectionId)!,
              units =
                quantityUnits(value.remaining) < excess
                  ? quantityUnits(value.remaining)
                  : excess;
            const seed = deps.hash([input.commandId, value.id]);
            const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-5${seed.slice(13, 16)}-${((parseInt(seed.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${seed.slice(18, 20)}-${seed.slice(20, 32)}`;
            await release(tx, {
              id,
              key: `native-demand:${id}`,
              reservationId: value.id,
              version: value.version,
              quantity: decimalQuantity(units),
              reason: input.status === 'cancelled' ? 'cancel' : 'amend',
              shipmentReadId: proof.id,
            });
            excess -= units;
          }
        }
      });
    },
    /** Consumes exact newly verified shipment units once; preparation and duplicate reads never dispatch stock. */
    async consumeVerified(
      context: TenantContext,
      input: {
        id: string;
        key: string;
        orderId: string;
        shipmentReadId: string;
        expected: { id: string; version: string }[];
      },
    ): Promise<ConsumptionResult> {
      const fresh = await access(context),
        commandHash = deps.hash(input);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.ledger.lockCommand(input.key);
        const retry = await tx.consumptionReceipt(input.key, commandHash);
        if (retry) return retry;
        await tx.lockOrder(input.orderId);
        const proof = await tx.shipmentRead(input.shipmentReadId);
        if (!proof)
          throw new LedgerError('source_incomplete', 'Shipment read not found');
        freshProof(proof, input.orderId, proof.connectionId);
        for (const locationId of [
          ...new Set(
            proof.shipments
              .filter(
                (shipment) =>
                  shipment.status === 'shipped' ||
                  shipment.status === 'delivered',
              )
              .map((shipment) => shipment.locationId!),
          ),
        ].sort())
          requireAllocationMode(
            (await tx.scope(proof.connectionId, locationId, true)).mode,
          );
        const originals = await tx.reservations(input.orderId, true),
          current = new Map(originals.map((value) => [value.id, value]));
        if (
          new Set(input.expected.map((value) => value.id)).size !==
          input.expected.length
        )
          throw new LedgerError(
            'invalid_entry',
            'Expected reservations must be distinct.',
          );
        const receipts: ConsumptionResult['ledger'] = [];
        let total = 0n;
        for (const shipment of proof.shipments.filter(
          (shipment) =>
            shipment.status === 'shipped' || shipment.status === 'delivered',
        )) {
          for (const line of shipment.lines) {
            const claimed = quantityUnits(
              await tx.shipmentClaim(
                proof.connectionId,
                shipment.id,
                line.orderLineId,
              ),
            );
            let remaining = quantityUnits(line.quantity) - claimed;
            if (remaining < 0n)
              throw new LedgerError(
                'stale',
                'Reported shipment units changed after consumption; review the retained history.',
              );
            if (remaining === 0n) continue;
            const candidates = [...current.values()]
              .filter(
                (value) =>
                  value.state === 'active' &&
                  value.orderLineId === line.orderLineId &&
                  value.locationId === shipment.locationId &&
                  value.unit === line.unit,
              )
              .sort(
                (a, b) =>
                  a.createdAt.localeCompare(b.createdAt) ||
                  a.id.localeCompare(b.id),
              );
            if (
              candidates.reduce(
                (sum, value) => sum + quantityUnits(value.remaining),
                0n,
              ) < remaining
            )
              throw new LedgerError(
                'insufficient_stock',
                'This shipment lacks enough exact remaining reservations. Review the unallocated physical effect.',
              );
            for (const value of candidates) {
              if (remaining === 0n) break;
              if (
                !input.expected.some(
                  (expected) =>
                    expected.id === value.id &&
                    expected.version ===
                      originals.find((original) => original.id === value.id)
                        ?.version,
                )
              )
                throw new LedgerError(
                  'stale',
                  'A reservation changed before shipment consumption.',
                );
              const quantity =
                  remaining < quantityUnits(value.remaining)
                    ? remaining
                    : quantityUnits(value.remaining),
                changed = consumeReservation(
                  value,
                  decimalQuantity(quantity),
                  now().toISOString(),
                );
              const seed = deps.hash([
                input.id,
                shipment.id,
                line.orderLineId,
                value.id,
              ]);
              const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-5${seed.slice(13, 16)}-${((parseInt(seed.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${seed.slice(18, 20)}-${seed.slice(20, 32)}`;
              const accounts = await tx.ledger.accounts(
                  [
                    reservationAddress(value, 'reserved'),
                    reservationAddress(value, 'customer'),
                  ],
                  true,
                ),
                from = accounts.find(
                  (account) => account.address.state === 'reserved',
                )!,
                to = accounts.find(
                  (account) => account.address.state === 'customer',
                )!;
              const command = reservationMovement(
                {
                  id,
                  key: `native-shipment:${id}`,
                  reason: 'Independently verified native shipment',
                  effectiveAt: null,
                  purpose: 'dispatch',
                  evidence: [
                    { kind: 'shipment', id: shipment.snapshotId },
                    { kind: 'observation', id: shipment.observationId },
                  ],
                },
                from,
                to,
                decimalQuantity(quantity),
              );
              const receipt = await tx.ledger.commit(
                command,
                deps.hash(command),
                accounts,
                null,
              );
              receipts.push(receipt);
              await tx.saveReservation(changed, value.version);
              await tx.saveConsumption(
                id,
                proof.connectionId,
                shipment.id,
                line.orderLineId,
                value.id,
                proof.id,
                receipt.entryId!,
                decimalQuantity(quantity),
              );
              current.set(value.id, changed);
              remaining -= quantity;
              total += quantity;
            }
            await tx.rememberShipmentClaim(
              proof.connectionId,
              shipment.id,
              line.orderLineId,
              line.quantity,
              proof.id,
            );
          }
        }
        const result: ConsumptionResult = {
          key: input.key,
          commandHash,
          consumed: decimalQuantity(total),
          reservations: [...current.values()].filter(
            (value) =>
              value.version !==
              originals.find((original) => original.id === value.id)?.version,
          ),
          ledger: receipts,
          shipmentReadId: proof.id,
        };
        await tx.rememberConsumption(result);
        await tx.audit(input.id, input.key, 'consumed', {
          orderId: input.orderId,
          consumed: result.consumed,
          shipmentReadId: proof.id,
        });

        return result;
      });
    },
    /** Allocates only real outstanding order demand and available stock, bound to exact source and ownership knowledge. */
    async allocate(
      context: TenantContext,
      input: AllocationInput,
    ): Promise<ReservationResult> {
      const fresh = await access(context),
        value = deps.allocation(input),
        commandHash = deps.hash(value);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.ledger.lockCommand(value.key);
        const retry = await tx.reservationReceipt(value.key, commandHash);
        if (retry) return retry;
        await tx.lockOrder(value.orderId);
        const demand = await tx.demand(value.orderId, true);
        if (!demand) throw notFound('Luma order not found');
        if (demand.version !== value.orderVersion || demand.status !== 'open')
          throw new LedgerError(
            'stale',
            'This order changed or no longer has open demand.',
          );
        const line = demand.lines.find((line) => line.id === value.orderLineId);
        if (!line?.skuId || line.unit !== value.unit)
          throw new LedgerError(
            'source_incomplete',
            'This exact order line needs a mapped stock-bearing SKU and unit.',
          );
        const scope = await tx.scope(
            value.connectionId,
            value.locationId,
            true,
          ),
          authority = await tx.authorityRevision();
        requireAllocationMode(scope.mode);
        if (
          scope.version !== value.ownershipVersion ||
          authority !== value.authorityRevision ||
          scope.authorityRevision !== authority
        )
          throw new LedgerError(
            'stale',
            'Location ownership or workspace authority changed.',
          );
        const proof = await tx.shipmentRead(value.shipmentReadId);
        freshProof(proof, value.orderId, value.connectionId);
        if (
          await tx.unsettled(
            value.connectionId,
            value.locationId,
            value.orderId,
          )
        )
          throw new LedgerError(
            'review_required',
            'Verify in-flight effects before allocating stock.',
          );
        const shipped = proof.shipments
          .filter(
            (shipment) =>
              shipment.status === 'shipped' || shipment.status === 'delivered',
          )
          .flatMap((shipment) => shipment.lines)
          .filter(
            (item) => item.orderLineId === line.id && item.unit === line.unit,
          )
          .reduce((sum, item) => sum + quantityUnits(item.quantity), 0n);
        const outstanding = quantityUnits(line.currentQuantity) - shipped;
        const reservations = await tx.reservations(value.orderId, true),
          already = reservations
            .filter(
              (reservation) =>
                reservation.orderLineId === line.id &&
                reservation.unit === line.unit,
            )
            .reduce(
              (sum, reservation) => sum + quantityUnits(reservation.remaining),
              0n,
            );
        const existing = reservations.find(
          (reservation) => reservation.id === value.reservationId,
        );
        if (
          reservations.some(
            (reservation) =>
              reservation.state === 'active' &&
              reservation.orderLineId === line.id &&
              reservation.locationId === value.locationId &&
              reservation.unit === line.unit &&
              reservation.id !== value.reservationId,
          )
        )
          throw new LedgerError(
            'stale',
            'Extend this location’s current reservation using its exact identity and version.',
          );
        if (
          existing &&
          (existing.version !== value.reservationVersion ||
            existing.state !== 'active' ||
            existing.skuId !== line.skuId ||
            existing.orderLineId !== line.id ||
            existing.locationId !== value.locationId ||
            existing.unit !== line.unit ||
            existing.expiresAt !== value.expiresAt)
        )
          throw new LedgerError(
            'stale',
            'This reservation identity, version or expiry changed.',
          );
        if (!existing && value.reservationVersion !== null)
          throw new LedgerError('stale', 'This reservation is unavailable.');
        if (value.expiresAt && Date.parse(value.expiresAt) <= now().getTime())
          throw new LedgerError(
            'stale',
            'Choose an unexpired reservation deadline.',
          );
        const base = {
          skuId: line.skuId,
          locationId: value.locationId,
          unit: line.unit,
        };
        if (!(await tx.ledger.opened(base.skuId, base.locationId, base.unit)))
          throw new LedgerError(
            'review_required',
            'Review an opening for this exact stock pool first.',
          );
        const accounts = await tx.ledger.accounts(
            [
              reservationAddress(base, 'available'),
              reservationAddress(base, 'reserved'),
            ],
            true,
          ),
          available = accounts.find(
            (account) => account.address.state === 'available',
          )!,
          reserved = accounts.find(
            (account) => account.address.state === 'reserved',
          )!;
        if (
          available.version !== value.available.version ||
          quantityUnits(available.balance) !==
            quantityUnits(value.available.balance)
        )
          throw new LedgerError(
            'stale',
            'Available stock changed after this allocation was prepared.',
          );
        const quantity = allocationQuantity(
          value.quantity,
          available.balance,
          decimalQuantity(outstanding > 0n ? outstanding : 0n),
          decimalQuantity(already),
        );
        let reservation: StockReservation | null = existing ?? null,
          ledger: ReservationResult['ledger'] = null;
        if (quantity.allocated !== '0') {
          const command = reservationMovement(
            {
              id: value.id,
              key: value.key,
              reason: 'Native order-line allocation',
              effectiveAt: now().toISOString(),
              purpose: 'reservation',
              evidence: [],
            },
            available,
            reserved,
            quantity.allocated,
          );
          ledger = await tx.ledger.commit(
            command,
            deps.hash(command),
            accounts,
            null,
          );
          reservation = existing
            ? {
                ...existing,
                version: nextStockVersion(existing.version),
                allocated: decimalQuantity(
                  quantityUnits(existing.allocated) +
                    quantityUnits(quantity.allocated),
                ),
                remaining: decimalQuantity(
                  quantityUnits(existing.remaining) +
                    quantityUnits(quantity.allocated),
                ),
                updatedAt: now().toISOString(),
              }
            : {
                id: value.reservationId,
                orderId: demand.orderId,
                orderLineId: line.id,
                ...base,
                version: '1',
                allocated: quantity.allocated,
                remaining: quantity.allocated,
                consumed: '0',
                released: '0',
                expiresAt: value.expiresAt,
                state: 'active',
                createdAt: now().toISOString(),
                updatedAt: now().toISOString(),
              };
          await tx.saveReservation(reservation, existing?.version ?? null);
        }
        const result: ReservationResult = {
          key: value.key,
          commandHash,
          reservation,
          allocated: quantity.allocated,
          unallocated: quantity.unallocated,
          ledger,
          orderVersion: demand.version,
        };
        await tx.rememberReservation(result);
        await tx.audit(value.id, value.key, 'allocated', {
          orderId: demand.orderId,
          orderLineId: line.id,
          allocated: quantity.allocated,
          unallocated: quantity.unallocated,
        });

        return result;
      });
    },
    /** Releases only a current reservation's remaining units after fresh settled shipment checks. */
    async release(context: TenantContext, input: ReleaseInput) {
      const fresh = await access(context),
        value = deps.release(input);

      return deps.store.transaction(fresh, (tx) => release(tx, value));
    },
  };
}
