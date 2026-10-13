import type { PurchasingOutcome } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';

import { usePermissions } from '../../kit/identity/permissions';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient().procurement;

/** Presents observed purchasing results and keeps all incomplete evidence outside verified totals. */
export function PurchasingOutcomePanel({
  organizationId,
  skuId,
  supplierId,
}: {
  organizationId: string;
  skuId?: string;
  supplierId?: string;
}) {
  const access = usePermissions(organizationId);
  const allowed =
    access.can('procurement.read') && access.can('inventory.read');
  const query = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'purchasing-outcomes',
    ],
    ...privateQueryDefaults,
    enabled: allowed,
    queryFn: ({ signal }) =>
      api.purchasingOutcomes({ params: { organizationId } }, { signal }),
  });
  if (!allowed || query.isPending || (query.data && !query.data.enabled))
    return null;
  const items =
    query.data?.items.filter(
      (item) =>
        (!skuId || item.skuId === skuId) &&
        (!supplierId || item.supplierId === supplierId),
    ) ?? [];
  const summary = {
    verifiedAvailable: items.filter(
      (i) => i.state === 'available_through_receipt',
    ).length,
    stockouts: items.filter((i) => i.state === 'stockout_observed').length,
    unknown: items.filter((i) => i.state === 'unknown').length,
  };
  const columns: DataTableColumn<PurchasingOutcome>[] = [
    {
      key: 'product',
      header: m.purchasing_product(),
      cell: (r) => (
        <span>
          {r.sku}
          <small>{r.supplierName}</small>
        </span>
      ),
    },
    {
      key: 'decision',
      header: m.purchasing_outcome_decision(),
      cell: (r) =>
        ({
          followed: m.purchasing_outcome_followed,
          changed: m.purchasing_outcome_changed,
          ignored: m.purchasing_outcome_ignored,
        })[r.decision](),
    },
    {
      key: 'quantity',
      header: m.purchasing_outcome_suggestion_choice(),
      numeric: true,
      cell: (r) =>
        `${r.suggested === null ? m.common_empty_value() : formatNumber(r.suggested)} / ${r.chosen === null ? m.common_empty_value() : formatNumber(r.chosen)}`,
    },
    {
      key: 'result',
      header: m.purchasing_outcome_result(),
      cell: (r) => (
        <Badge
          tone={
            r.state === 'stockout_observed'
              ? 'warning'
              : r.state === 'available_through_receipt'
                ? 'success'
                : 'neutral'
          }
        >
          {{
            unknown: m.purchasing_outcome_unknown,
            stockout_observed: m.purchasing_outcome_stockout,
            available_through_receipt: m.purchasing_outcome_available,
          }[r.state]()}
        </Badge>
      ),
    },
    {
      key: 'receipt',
      header: m.purchasing_outcome_receipt(),
      cell: (r) =>
        r.receiptAt ? (
          <WorkspaceDate value={r.receiptAt} />
        ) : (
          m.common_empty_value()
        ),
    },
    {
      key: 'duration',
      header: m.purchasing_outcome_duration(),
      numeric: true,
      cell: (r) =>
        r.observedStockoutMinutes === null
          ? m.common_empty_value()
          : m.purchasing_outcome_minutes({
              minutes: formatNumber(r.observedStockoutMinutes, {
                maximumFractionDigits: 1,
              }),
            }),
    },
    {
      key: 'excess',
      header: m.purchasing_outcome_excess(),
      numeric: true,
      cell: (r) =>
        r.aboveTarget === null
          ? m.common_empty_value()
          : formatNumber(r.aboveTarget),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.purchasing_outcomes_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <p>{m.purchasing_outcomes_explanation()}</p>
        {query.error ? (
          <Alert tone="warning">
            <p>{m.purchasing_outcomes_unavailable()}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : query.data ? (
          <>
            <p>
              {m.purchasing_outcomes_summary({
                available: summary.verifiedAvailable,
                stockouts: summary.stockouts,
                unknown: summary.unknown,
              })}
            </p>
            {query.data.truncated ? (
              <Alert tone="warning">{m.purchasing_truncated()}</Alert>
            ) : null}
            {items.length ? (
              <DataTable
                caption={m.purchasing_outcomes_title()}
                columns={columns}
                rows={items}
                rowKey={(r) => r.id}
                density="compact"
                variant="plain"
              />
            ) : (
              <Empty>
                <h3>{m.purchasing_outcomes_empty()}</h3>
              </Empty>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
