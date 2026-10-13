import './incoming-stock.css';

import type { IncomingStock } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { useCan } from '../../kit/identity/permissions';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

type Item = IncomingStock['items'][number];

const statuses = {
  confirmed: m.procurement_incoming_confirmed,
  requested: m.procurement_incoming_requested,
  overdue: m.procurement_incoming_overdue,
  unknown: m.procurement_incoming_unknown,
};

/** Shows expected arrivals separately from stock available to sell, with exact source and date confidence. */
export function IncomingStockSection({
  organizationId,
  skuId,
  locationId,
}: {
  organizationId: string;
  skuId: string;
  locationId?: string | undefined;
}) {
  const allowed = useCan(organizationId, 'inventory.read');
  const query = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'procurement',
      'incoming',
      skuId,
      locationId,
    ],
    ...privateQueryDefaults,
    enabled: allowed,
    queryFn: ({ signal }) =>
      api.procurement.incomingStock(
        {
          params: { organizationId },
          body: { skuIds: [skuId], ...(locationId ? { locationId } : {}) },
        },
        { signal },
      ),
  });
  if (!allowed || query.data?.enabled === false) return null;

  return (
    <Card as="section" className="incoming-stock">
      <CardHeader>
        <CardTitle>{m.procurement_incoming_title()}</CardTitle>
        <CardDescription>{m.procurement_incoming_note()}</CardDescription>
      </CardHeader>
      {query.isPending ? <p role="status">{m.common_loading()}</p> : null}
      {query.error ? (
        <Alert tone="danger" role="alert">
          <p>{m.procurement_incoming_unavailable()}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {query.data?.supplierOrdersUnavailable ? (
        <Alert tone="warning">
          {m.procurement_incoming_supplier_unavailable()}
        </Alert>
      ) : null}
      {query.data?.items.length === 0 &&
      !query.data.supplierOrdersUnavailable ? (
        <p>{m.procurement_incoming_empty()}</p>
      ) : null}
      {query.data?.truncated ? (
        <Alert tone="warning">{m.procurement_incoming_truncated()}</Alert>
      ) : null}
      {query.data?.items.length ? (
        <DataTable<Item>
          caption={m.procurement_incoming_title()}
          density="compact"
          rows={query.data.items}
          rowKey={(item) => item.key}
          columns={[
            {
              key: 'source',
              header: m.procurement_incoming_source(),
              cell: (item) => (
                <span className="incoming-stock-cell">
                  <span>
                    {item.source === 'purchase_order'
                      ? m.procurement_incoming_supplier()
                      : item.source === 'transfer'
                        ? m.procurement_incoming_transfer()
                        : m.procurement_incoming_ledger()}
                  </span>
                  {item.orderId ? (
                    <Link
                      to="/app/$organizationId/procurement/$purchaseOrderId"
                      params={{ organizationId, purchaseOrderId: item.orderId }}
                    >
                      {item.orderReference}
                    </Link>
                  ) : (
                    <span>{item.orderReference}</span>
                  )}
                  {item.supplierId ? (
                    <Link
                      to="/app/$organizationId/procurement/suppliers/$supplierId"
                      params={{ organizationId, supplierId: item.supplierId }}
                    >
                      {item.supplierName}
                    </Link>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'location',
              header: m.procurement_incoming_location(),
              cell: (item) => item.location ?? m.procurement_incoming_unknown(),
            },
            {
              key: 'quantity',
              header: m.procurement_incoming_quantity(),
              cell: (item) =>
                `${formatNumber(item.quantity, { maximumFractionDigits: 6 })} ${item.unit}`,
            },
            {
              key: 'arrival',
              header: m.procurement_incoming_arrival(),
              cell: (item) => (
                <span className="incoming-stock-cell">
                  <Badge
                    tone={item.dateStatus === 'overdue' ? 'warning' : 'neutral'}
                  >
                    {statuses[item.dateStatus]()}
                  </Badge>
                  {item.expectedDate ? (
                    <WorkspaceDate value={item.expectedDate} />
                  ) : null}
                </span>
              ),
            },
            {
              key: 'evidence',
              header: m.procurement_incoming_observed(),
              cell: (item) => (
                <span className="incoming-stock-cell">
                  <WorkspaceDate value={item.observedAt} />
                  {item.freshness === 'stale' ? (
                    <Badge tone="warning">
                      {m.procurement_incoming_stale()}
                    </Badge>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      ) : null}
    </Card>
  );
}
