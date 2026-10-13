import './inventory.css';

import type { TransferDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { stockQuantity } from './presentation';
import {
  TransferEvidence,
  transferStates as states,
} from './transfer-presentation';
import { TransferTable } from './transfer-table';

/** Presents source lifecycle, exact identities, receiving categories and a reviewable evidence export. */
export function TransferDetailView({
  organizationId,
  detail,
  actions,
}: {
  organizationId: string;
  detail: TransferDetail;
  actions?: ReactNode;
}) {
  const { record, data } = detail;
  const header = (
    <RecordHeader
      section={{
        label: m.inventory_transfer_title(),
        domain: 'inventory',
        link: (
          <Link
            to="/app/$organizationId/inventory/transfers"
            params={{ organizationId }}
          />
        ),
      }}
      title={record.name}
      description={record.label}
      status={(
        states[data?.status ?? 'unknown'] ?? m.inventory_transfer_unknown
      )()}
      actions={actions}
    />
  );
  if (!data)
    return (
      <>
        {header}
        <Alert>{m.inventory_transfer_removed()}</Alert>
        {record.evidence === 'removed' ? null : (
          <TransferEvidence item={record} />
        )}
        <p>{m.inventory_transfer_claim_context()}</p>
        <Button variant="outline" onClick={() => download(detail)}>
          {m.inventory_transfer_evidence()}
        </Button>
        <TransferHistory detail={detail} />
      </>
    );
  const lines = data.lines;

  return (
    <>
      {header}

      {detail.deleted ? <Alert>{m.inventory_transfer_removed()}</Alert> : null}
      {detail.deleted ? null : <TransferEvidence item={record} />}
      <Alert>{m.inventory_transfer_intro()}</Alert>
      <Card className="inventory-section">
        <dl className="inventory-transfer-facts">
          <dt>{m.inventory_transfer_requested()}</dt>
          <dd>{stockQuantity(record.facts.requested)}</dd>
          <dt>{m.inventory_transfer_shipped()}</dt>
          <dd>{stockQuantity(record.facts.shipped)}</dd>
          <dt>{m.inventory_transfer_received()}</dt>
          <dd>{stockQuantity(record.facts.received)}</dd>
          {data.type === 'inventory_shipment' ? (
            <>
              <dt>{m.inventory_transfer_accepted()}</dt>
              <dd>
                {stockQuantity(detail.deleted ? null : data.acceptedQuantity)}
              </dd>
              <dt>{m.inventory_transfer_rejected_quantity()}</dt>
              <dd>
                {stockQuantity(detail.deleted ? null : data.rejectedQuantity)}
              </dd>
              <dt>{m.inventory_transfer_unreceived()}</dt>
              <dd>{stockQuantity(record.facts.unreceived)}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Card className="inventory-section">
        <h2>{m.inventory_transfer_lifecycle()}</h2>
        <dl className="inventory-transfer-facts">
          <dt>{m.inventory_transfer_created()}</dt>
          <dd>
            <DateValue value={data.createdAt} />
          </dd>
          {'shippedAt' in data ? (
            <>
              <dt>{m.inventory_transfer_shipped()}</dt>
              <dd>
                <DateValue value={data.shippedAt} />
              </dd>
              <dt>{m.inventory_transfer_first_receipt()}</dt>
              <dd>
                <DateValue value={data.receivedAt} />
              </dd>
              <dt>{m.inventory_transfer_eta()}</dt>
              <dd>
                <DateValue value={data.expectedArrivalAt} />
              </dd>
            </>
          ) : null}
          <dt>{m.inventory_history_read()}</dt>
          <dd>
            <WorkspaceDate value={record.observedAt} />
          </dd>
          <dt>{m.inventory_transfer_snapshot()}</dt>
          <dd>{record.snapshotId}</dd>
        </dl>
      </Card>
      {data.type === 'inventory_transfer' ? (
        <Card className="inventory-section">
          <h2>{m.inventory_transfer_locations()}</h2>
          {(
            [
              ['origin', data.origin],
              ['destination', data.destination],
            ] as const
          ).map(([side, location]) => (
            <section key={side}>
              <h3>
                {side === 'origin'
                  ? m.inventory_transfer_origin()
                  : m.inventory_transfer_destination()}
              </h3>
              {location ? (
                <>
                  <p>
                    <strong>{location.name}</strong> ·{' '}
                    <WorkspaceDate value={location.snapshottedAt} />
                  </p>
                  <p>
                    {Object.values(location.address).filter(Boolean).join(', ')}
                  </p>
                  {location.sourceId ? (
                    <p>{location.sourceId.externalId}</p>
                  ) : (
                    <Alert>{m.inventory_transfer_location_unknown()}</Alert>
                  )}
                </>
              ) : (
                <p>{m.common_not_reported()}</p>
              )}
            </section>
          ))}
        </Card>
      ) : null}
      <Card className="inventory-section">
        <h2>{m.inventory_transfer_lines()}</h2>
        {lines === null ? (
          <Alert>{m.inventory_transfer_incomplete()}</Alert>
        ) : (
          <DataTable<Line>
            caption={m.inventory_transfer_lines()}
            rows={lines}
            rowKey={(line) =>
              JSON.stringify([line.sourceId.externalId, line.sourceId.scopeKey])
            }
            columns={[
              {
                key: 'line',
                header: m.inventory_transfer_line(),
                cell: (line) => (
                  <div className="inventory-cell">
                    <span>{'title' in line ? line.title : null}</span>
                    <small>{line.sourceId.externalId}</small>
                    <small>
                      {line.sourceSku?.externalId ?? m.common_not_reported()}
                    </small>
                    {line.skuId ? (
                      <Link
                        to="/app/$organizationId/inventory"
                        params={{ organizationId }}
                        search={{ skuId: line.skuId }}
                      >
                        {m.inventory_transfer_stock()}
                      </Link>
                    ) : null}
                  </div>
                ),
              },
              ...(data.type === 'inventory_transfer'
                ? [
                    {
                      key: 'requested',
                      header: m.inventory_transfer_requested(),
                      cell: (line: Line) =>
                        stockQuantity(
                          'requested' in line ? line.requested : null,
                        ),
                    },
                    {
                      key: 'picked',
                      header: m.inventory_transfer_picked(),
                      cell: (line: Line) =>
                        stockQuantity('picked' in line ? line.picked : null),
                    },
                    {
                      key: 'ready',
                      header: m.inventory_transfer_ready(),
                      cell: (line: Line) =>
                        stockQuantity('ready' in line ? line.ready : null),
                    },
                    {
                      key: 'shipped',
                      header: m.inventory_transfer_shipped(),
                      cell: (line: Line) =>
                        stockQuantity('shipped' in line ? line.shipped : null),
                    },
                  ]
                : [
                    {
                      key: 'quantity',
                      header: m.inventory_transfer_shipped(),
                      cell: (line: Line) =>
                        stockQuantity(
                          'quantity' in line ? line.quantity : null,
                        ),
                    },
                    {
                      key: 'accepted',
                      header: m.inventory_transfer_accepted(),
                      cell: (line: Line) =>
                        stockQuantity(
                          'accepted' in line ? line.accepted : null,
                        ),
                    },
                    {
                      key: 'rejected',
                      header: m.inventory_transfer_rejected_quantity(),
                      cell: (line: Line) =>
                        stockQuantity(
                          'rejected' in line ? line.rejected : null,
                        ),
                    },
                    {
                      key: 'unreceived',
                      header: m.inventory_transfer_unreceived(),
                      cell: (line: Line) =>
                        stockQuantity(
                          'unreceived' in line ? line.unreceived : null,
                        ),
                    },
                  ]),
            ]}
          />
        )}
      </Card>
      <Card className="inventory-section">
        <h2>{m.inventory_transfer_relationships()}</h2>
        {data.type === 'inventory_transfer' && data.shipmentSources === null ? (
          <Alert>{m.inventory_transfer_relationships_unknown()}</Alert>
        ) : detail.shipments.length || detail.transfers.length ? (
          <TransferTable
            organizationId={organizationId}
            items={[...detail.transfers, ...detail.shipments]}
          />
        ) : (
          <p>{m.inventory_transfer_no_relationships()}</p>
        )}
        <h3>{m.inventory_transfer_procurement()}</h3>
        {detail.hidden.includes('purchaseOrders') ? (
          <p>{m.inventory_transfer_procurement_hidden()}</p>
        ) : detail.purchaseOrders.length ? (
          <ul>
            {detail.purchaseOrders.map((order) => (
              <li key={order.id}>
                <Link
                  to="/app/$organizationId/procurement/$purchaseOrderId"
                  params={{ organizationId, purchaseOrderId: order.id }}
                >
                  {order.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>{m.inventory_transfer_no_relationships()}</p>
        )}
      </Card>
      <Card className="inventory-section">
        <p>{m.inventory_transfer_claim_context()}</p>
        <Button variant="outline" onClick={() => download(detail)}>
          {m.inventory_transfer_evidence()}
        </Button>
      </Card>
      <TransferHistory detail={detail} />
    </>
  );
}

type Line = NonNullable<NonNullable<TransferDetail['data']>['lines']>[number];

function DateValue({ value }: { value: string | null }) {
  return value ? (
    <WorkspaceDate value={value} />
  ) : (
    <span>{m.common_not_reported()}</span>
  );
}

function download(detail: TransferDetail) {
  const data = {
    schemaVersion: 'receiving-evidence/1',
    ...detail,
    supplemental: {
      supplierConfirmation: null,
      deliveryDocuments: [],
      photos: [],
      claimDeadline: null,
    },
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `receiving-${detail.record.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function TransferHistory({ detail }: { detail: TransferDetail }) {
  return (
    <>
      <Disclosure>
        <summary>{m.inventory_transfer_history()}</summary>
        <DataTable
          caption={m.inventory_transfer_history()}
          rows={detail.history}
          rowKey={(item) => item.snapshotId}
          columns={[
            {
              key: 'observed',
              header: m.inventory_history_read(),
              cell: (item) => <WorkspaceDate value={item.observedAt} />,
            },
            {
              key: 'snapshot',
              header: m.inventory_transfer_snapshot(),
              cell: (item) => (
                <span>
                  {item.snapshotId}
                  <br />
                  {item.deleted
                    ? m.inventory_transfer_removed()
                    : (states[item.status] ?? m.inventory_transfer_unknown)()}
                </span>
              ),
            },
            {
              key: 'received',
              header: m.inventory_transfer_received(),
              cell: (item) =>
                stockQuantity(item.deleted ? null : item.receivedQuantity),
            },
            {
              key: 'locations',
              header: m.inventory_transfer_locations(),
              cell: (item) => (
                <span>
                  {item.origin?.name ?? m.common_not_reported()} →{' '}
                  {item.destination?.name ?? m.common_not_reported()}
                </span>
              ),
            },
          ]}
        />
      </Disclosure>
      {detail.relatedTruncated ? (
        <Alert>{m.inventory_transfer_truncated()}</Alert>
      ) : null}
    </>
  );
}
