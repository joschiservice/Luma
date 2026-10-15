import type {
  InventoryDetail,
  nativeLedgerReviewSchema,
  nativeOwnershipReviewSchema,
  nativeScopeSchema,
  nativeStockEvidenceSchema,
} from '@luma/api-contract';
import {
  formatExactQuantity,
  formatNumber,
  parseExactQuantityInput,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';

import { contextOptions } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();
const nativeStateLabels = {
  available: m.inventory_native_stock_available,
  reserved: m.inventory_native_stock_reserved,
  held: m.inventory_native_stock_held,
  quarantine: m.inventory_native_stock_quarantine,
  damaged: m.inventory_native_stock_damaged,
  returned_inspection: m.inventory_native_stock_returned_inspection,
  incoming: m.inventory_native_stock_incoming,
  in_transit: m.inventory_native_stock_in_transit,
  supplier: m.inventory_native_stock_supplier,
  customer: m.inventory_native_stock_customer,
  loss: m.inventory_native_stock_loss,
  adjustment: m.inventory_native_stock_adjustment,
  production: m.inventory_native_stock_production,
  external: m.inventory_native_stock_external,
};
const phaseLabels = {
  observe: m.inventory_native_stock_phase_observe,
  shadow: m.inventory_native_stock_phase_shadow,
  propose: m.inventory_native_stock_phase_propose,
  own: m.inventory_native_stock_phase_own,
};
const openingStates = [
  'available',
  'held',
  'quarantine',
  'damaged',
  'returned_inspection',
  'incoming',
] as const;

/** Inspects native stock beside its independent sources and exposes exact peer-reviewed opening and handover controls. */
export function NativeStockPool({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: InventoryDetail;
}) {
  const [connectionId, setConnectionId] = useState(
    detail.position.sources[0]?.connectionId ?? '',
  );
  const identity = useQuery(contextOptions(organizationId));
  const params = {
    organizationId,
    skuId: detail.position.skuId,
    locationId: detail.position.locationId,
    connectionId,
  };
  const client = useQueryClient();
  const query = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'inventory',
      'native',
      params,
      detail.position.unit,
    ],
    enabled: !!connectionId,
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      api.nativeStock.pool(
        { params, query: { unit: detail.position.unit } },
        { signal },
      ),
  });
  const [reason, setReason] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID());
  const [balances, setBalances] = useState<
    Partial<Record<(typeof openingStates)[number], string>>
  >({});
  const [proposal, setProposal] = useState<
    | { kind: 'ledger'; value: z.infer<typeof nativeLedgerReviewSchema> }
    | { kind: 'ownership'; value: z.infer<typeof nativeOwnershipReviewSchema> }
    | null
  >(null);
  const [comparison, setComparison] = useState<string | null>(null);
  const [sourceEvidence, setSourceEvidence] = useState<z.infer<
    typeof nativeStockEvidenceSchema
  > | null>(null);
  const manage =
    !!identity.data?.permissions.includes('inventory.manage') &&
    !identity.data.supportView;
  const approve =
    !!identity.data?.permissions.includes('inventory.approve') &&
    !identity.data.supportView;
  const snapshot = detail.history.entries.find(
    (entry) => entry.current && entry.connectionId === connectionId,
  );
  const changed = async () => {
    await client.invalidateQueries({
      queryKey: ['private', 'organization', organizationId],
    });
  };
  const operation = useMutation({
    mutationFn: async (
      action:
        | 'readStock'
        | 'opening'
        | 'reconcile'
        | 'step'
        | 'handback'
        | 'approve'
        | 'reject'
        | 'apply',
    ) => {
      if (action === 'readStock') {
        setSourceEvidence(null);
        setSourceEvidence(
          await api.nativeStock.readStock({
            params: { organizationId },
            body: {
              connectionId,
              skuId: params.skuId,
              locationId: params.locationId,
              unit: detail.position.unit,
            },
          }),
        );
      } else if (action === 'opening') {
        if (!sourceEvidence && !snapshot)
          throw new Error(m.inventory_native_stock_unavailable());
        const parsedBalances: Partial<
          Record<(typeof openingStates)[number], string>
        > = {};
        for (const state of openingStates) {
          const entered = balances[state];
          if (entered !== undefined) {
            const parsed = parseExactQuantityInput(entered);
            if (parsed === null)
              throw new Error(m.inventory_native_stock_quantity_invalid());
            parsedBalances[state] = parsed;
          }
        }
        const value = await api.nativeStock.prepareOpening({
          params: { organizationId },
          body: {
            id: key,
            key,
            snapshotId: sourceEvidence?.snapshotId ?? snapshot!.id,
            reason,
            balances: parsedBalances,
          },
        });
        setProposal({ kind: 'ledger', value });
        setKey(crypto.randomUUID());
      } else if (action === 'reconcile') {
        if (!sourceEvidence && !snapshot)
          throw new Error(m.inventory_native_stock_unavailable());
        const value = await api.nativeStock.reconcile({
          params: { organizationId },
          body: {
            id: key,
            key,
            snapshotId: sourceEvidence?.snapshotId ?? snapshot!.id,
          },
        });
        setComparison(formatExactQuantity(value.driftQuantity));
        setKey(crypto.randomUUID());
      } else if (action === 'step' || action === 'handback') {
        if (!query.data)
          throw new Error(m.inventory_native_stock_unavailable());
        const next: Record<
          z.infer<typeof nativeScopeSchema>['mode'],
          z.infer<typeof nativeScopeSchema>['mode']
        > = {
          observe: 'shadow',
          shadow: 'propose',
          propose: 'own',
          own: 'observe',
        };
        const value = await api.nativeStock.prepareOwnership({
          params: { organizationId },
          body: {
            id: key,
            key,
            connectionId,
            locationId: params.locationId,
            version: query.data.scope.version,
            to: action === 'handback' ? 'observe' : next[query.data.scope.mode],
            reason,
          },
        });
        setProposal({ kind: 'ownership', value });
        setKey(crypto.randomUUID());
      } else if (proposal) {
        const reviewParams = { organizationId, reviewId: proposal.value.id };
        if (action === 'apply') {
          if (proposal.kind === 'ledger')
            await api.nativeStock.applyLedger({ params: reviewParams });
          else await api.nativeStock.applyOwnership({ params: reviewParams });
          setProposal(null);
        } else {
          const body = { approved: action === 'approve' };
          if (proposal.kind === 'ledger')
            setProposal({
              kind: 'ledger',
              value: await api.nativeStock.reviewLedger({
                params: reviewParams,
                body,
              }),
            });
          else
            setProposal({
              kind: 'ownership',
              value: await api.nativeStock.reviewOwnership({
                params: reviewParams,
                body,
              }),
            });
        }
      }
    },
    onSuccess: changed,
  });
  const inspect = useMutation({
    mutationFn: async (input: { id: string; kind: 'ledger' | 'ownership' }) => {
      const params = { organizationId, reviewId: input.id };
      if (input.kind === 'ledger')
        setProposal({
          kind: 'ledger',
          value: await api.nativeStock.ledgerReview({ params }),
        });
      else
        setProposal({
          kind: 'ownership',
          value: await api.nativeStock.ownershipReview({ params }),
        });
    },
  });

  return (
    <Card className="inventory-section inventory-native-stock">
      <CardHeader>
        <CardTitle as="h2">{m.inventory_native_stock_title()}</CardTitle>
      </CardHeader>
      <p>{m.inventory_native_stock_note()}</p>
      <label>
        {m.inventory_native_stock_source()}
        <Select
          value={connectionId}
          onValueChange={(value) => {
            if (value) {
              setConnectionId(value);
              setProposal(null);
              setComparison(null);
              setSourceEvidence(null);
            }
          }}
          options={detail.position.sources.map((source) => ({
            value: source.connectionId,
            label: source.label,
          }))}
        />
      </label>
      {manage ? (
        <Button
          variant="outline"
          disabled={
            operation.isPending ||
            !identity.data?.permissions.includes('sync.manage')
          }
          onClick={() => operation.mutate('readStock')}
        >
          {m.inventory_native_stock_read_source()}
        </Button>
      ) : null}
      {sourceEvidence &&
      (!sourceEvidence.complete || sourceEvidence.bundleParent !== false) ? (
        <Alert tone="warning">
          {m.inventory_native_stock_source_blocked()}
        </Alert>
      ) : null}
      {sourceEvidence ? (
        <p role="status">
          {m.inventory_history_read()}:{' '}
          <WorkspaceDate value={sourceEvidence.observedAt} />
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status">{m.inventory_native_stock_loading()}</p>
      ) : query.isError ? (
        <Alert tone="warning">
          {m.inventory_native_stock_unavailable()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : query.data ? (
        <>
          <p>
            {phaseLabels[query.data.scope.mode]()} ·{' '}
            {detail.position.sources.find(
              (source) =>
                source.connectionId === query.data?.scope.connectionId,
            )?.label ?? m.common_not_reported()}{' '}
            · {m.inventory_native_stock_version()} {query.data.scope.version}
          </p>
          <p>{m.inventory_native_stock_scope_note()}</p>
          {query.data.opened ? (
            <DataTable
              caption={m.inventory_native_stock_title()}
              rows={query.data.accounts}
              rowKey={(account) => account.id}
              columns={[
                {
                  key: 'state',
                  header: m.inventory_native_stock_state(),
                  cell: (account) => nativeStateLabels[account.address.state](),
                },
                {
                  key: 'balance',
                  header: m.inventory_native_stock_quantity(),
                  numeric: true,
                  cell: (account) => formatExactQuantity(account.balance),
                },
                {
                  key: 'version',
                  header: m.inventory_native_stock_version(),
                  numeric: true,
                  cell: (account) => account.version,
                },
              ]}
            />
          ) : (
            <Alert>{m.inventory_native_stock_unopened()}</Alert>
          )}
          {manage ? (
            <Disclosure>
              <summary>
                {query.data.opened
                  ? m.inventory_native_stock_prepare_step()
                  : m.inventory_native_stock_prepare_opening()}
              </summary>
              <form
                className="native-stock-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  operation.mutate(query.data?.opened ? 'step' : 'opening');
                }}
              >
                <fieldset disabled={operation.isPending}>
                  <p>{m.inventory_native_stock_quantity_hint()}</p>
                  {!query.data.opened
                    ? openingStates.map((state) => (
                        <label key={state}>
                          {nativeStateLabels[state]()}
                          <Input
                            value={balances[state] ?? ''}
                            inputMode="decimal"
                            onChange={(event) =>
                              setBalances({
                                ...balances,
                                [state]: event.target.value || undefined,
                              })
                            }
                          />
                        </label>
                      ))
                    : null}
                  <label>
                    {m.inventory_native_stock_reason()}
                    <Input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      required
                      maxLength={1024}
                    />
                  </label>
                  <Button type="submit">
                    {query.data.opened
                      ? m.inventory_native_stock_prepare_step()
                      : m.inventory_native_stock_prepare_opening()}
                  </Button>
                  {query.data.opened ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => operation.mutate('reconcile')}
                    >
                      {m.inventory_native_stock_reconcile()}
                    </Button>
                  ) : null}
                  {query.data.scope.mode !== 'observe' ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!reason.trim()}
                      onClick={() => operation.mutate('handback')}
                    >
                      {m.inventory_native_stock_handback()}
                    </Button>
                  ) : null}
                </fieldset>
              </form>
            </Disclosure>
          ) : null}
          {comparison !== null ? (
            <Alert role="status">
              {m.inventory_native_stock_external()}: {comparison}
            </Alert>
          ) : null}
          {[
            ...query.data.pendingReviews.map((review) => ({
              id: review.id,
              kind: 'ledger' as const,
            })),
            ...query.data.ownershipReviews.map((review) => ({
              id: review.id,
              kind: 'ownership' as const,
            })),
          ].map((review) => (
            <Button
              key={review.id}
              variant="outline"
              disabled={inspect.isPending}
              onClick={() => inspect.mutate(review)}
            >
              {m.inventory_native_stock_review()} ·{' '}
              {review.kind === 'ledger'
                ? m.inventory_native_stock_prepare_opening()
                : m.inventory_native_stock_prepare_step()}
            </Button>
          ))}
        </>
      ) : null}
      {proposal ? (
        <section aria-label={m.inventory_native_stock_reviews()}>
          <h3>{m.inventory_native_stock_review()}</h3>
          <p>
            {proposal.value.state === 'pending'
              ? m.inventory_native_stock_reviews()
              : proposal.value.state === 'approved'
                ? m.inventory_native_stock_approve()
                : m.inventory_native_stock_reject()}
          </p>
          {proposal.kind === 'ledger' ? (
            <>
              <p>{proposal.value.command.reason}</p>
              <DataTable
                caption={m.inventory_native_stock_quantity()}
                rows={proposal.value.command.postings}
                rowKey={(posting) =>
                  `${posting.account.skuId}:${posting.account.locationId}:${posting.account.state}`
                }
                columns={[
                  {
                    key: 'state',
                    header: m.inventory_native_stock_state(),
                    cell: (posting) =>
                      nativeStateLabels[posting.account.state](),
                  },
                  {
                    key: 'quantity',
                    header: m.inventory_native_stock_quantity(),
                    numeric: true,
                    cell: (posting) => formatExactQuantity(posting.quantity),
                  },
                ]}
              />
            </>
          ) : (
            <>
              <p>{proposal.value.reason}</p>
              <p>
                {phaseLabels[proposal.value.from]()} →{' '}
                {phaseLabels[proposal.value.to]()} ·{' '}
                {formatNumber(proposal.value.binding.pools.length)}{' '}
                {m.inventory_native_stock_title()} ·{' '}
                {m.inventory_native_stock_version()}{' '}
                {proposal.value.binding.scopeVersion}
              </p>
            </>
          )}
          {proposal.value.state === 'pending' &&
          approve &&
          proposal.value.preparedBy !== identity.data?.actor.id ? (
            <>
              <Button
                disabled={operation.isPending}
                onClick={() => operation.mutate('approve')}
              >
                {m.inventory_native_stock_approve()}
              </Button>
              <Button
                variant="outline"
                disabled={operation.isPending}
                onClick={() => operation.mutate('reject')}
              >
                {m.inventory_native_stock_reject()}
              </Button>
            </>
          ) : null}
          {proposal.value.state === 'approved' &&
          manage &&
          proposal.value.preparedBy === identity.data?.actor.id ? (
            <Button
              disabled={operation.isPending}
              onClick={() => operation.mutate('apply')}
            >
              {m.inventory_native_stock_apply()}
            </Button>
          ) : null}
        </section>
      ) : null}
      {operation.error || inspect.error ? (
        <Alert tone="warning" role="alert">
          {(operation.error ?? inspect.error)?.message}
        </Alert>
      ) : null}
    </Card>
  );
}
