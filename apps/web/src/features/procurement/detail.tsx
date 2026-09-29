import './procurement.css';

import type { PurchaseOrder, PurchaseOrderStatus } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Check, FileText, Link2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { procurementError, purchaseOrderOptions } from './data';
import { TransitionDialog } from './forms';
import { OrderStatus, statusLabels } from './presentation';

const lineColumns: DataTableColumn<PurchaseOrder['lines'][number]>[] = [
  { key: 'item', header: 'Item', cell: (line) => line.description },
  { key: 'sku', header: 'SKU', cell: (line) => <code>{line.sku}</code> },
  {
    key: 'quantity',
    header: 'Quantity',
    numeric: true,
    cell: (line) => (
      <>
        {line.quantity.toLocaleString(undefined, {
          maximumSignificantDigits: 15,
        })}{' '}
        <span className="procurement-unit">{line.unit}</span>
      </>
    ),
  },
];

/** Shows an order's immutable commercial details, ownership and audited lifecycle. */
export function PurchaseOrderPage() {
  const { organizationId, purchaseOrderId } = useParams({
    from: '/app/$organizationId/procurement/$purchaseOrderId',
  });
  const query = useQuery(purchaseOrderOptions(organizationId, purchaseOrderId));
  const [transition, setTransition] = useState<PurchaseOrderStatus | null>(
    null,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const back = (
    <Link
      className="procurement-back"
      to="/app/$organizationId/procurement"
      params={{ organizationId }}
      search={{ view: 'orders', q: '', status: '' }}
    >
      <ArrowLeft size={15} />
      Purchase orders
    </Link>
  );
  if (query.isPending)
    return (
      <div className="procurement-page">
        {back}
        <p role="status">Loading purchase order…</p>
      </div>
    );
  if (query.error || !query.data)
    return (
      <div className="procurement-page">
        {back}
        <Alert tone="danger" role="alert">
          {procurementError(query.error)}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      </div>
    );
  const { order, history, allowedTransitions } = query.data;

  return (
    <div className="procurement-page procurement-detail">
      {back}
      <header className="procurement-detail-header">
        <div className="procurement-detail-title">
          <span className="procurement-record-icon">
            <FileText size={22} />
          </span>
          <div>
            <p className="procurement-eyebrow">Purchase order</p>
            <h1>{order.reference}</h1>
            <p>{order.supplierName}</p>
          </div>
        </div>
        <OrderStatus status={order.status} />
      </header>
      <div className="procurement-detail-grid">
        <div className="procurement-detail-main">
          <section className="procurement-panel">
            <div className="procurement-panel-heading">
              <h2>Order lines</h2>
              <Badge>
                {order.lines.length}{' '}
                {order.lines.length === 1 ? 'line' : 'lines'}
              </Badge>
            </div>
            <DataTable
              caption="Order lines"
              variant="plain"
              columns={lineColumns}
              rows={order.lines}
              rowKey={(line) => line.id}
            />
          </section>
          <section className="procurement-panel">
            <div className="procurement-panel-heading">
              <h2>Lifecycle history</h2>
              <span>Revision {order.revision}</span>
            </div>
            <ol className="procurement-timeline">
              {history.map((event) => (
                <li key={event.id}>
                  <span className="procurement-timeline-mark">
                    <Check size={12} />
                  </span>
                  <div>
                    <h3>
                      {event.from
                        ? `${statusLabels[event.from]} → ${statusLabels[event.to]}`
                        : 'Purchase order created'}
                    </h3>
                    {event.from && <p>{event.reason}</p>}
                    <WorkspaceDate value={event.occurredAt} />
                    <details>
                      <summary>Actor and event</summary>
                      <p>
                        Actor <code>{event.actorId}</code>
                      </p>
                      <p>
                        Event <code>{event.id}</code>
                      </p>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="procurement-detail-aside">
          <section className="procurement-panel">
            <div className="procurement-panel-heading">
              <h2>
                <ShieldCheck size={16} />
                Ownership
              </h2>
            </div>
            <div className="procurement-panel-body">
              <strong>
                {order.authority === 'luma'
                  ? 'Luma is authoritative'
                  : 'Externally owned'}
              </strong>
              <p>
                {order.authority === 'luma'
                  ? 'This purchase order and its lifecycle are managed in Luma.'
                  : 'Lifecycle changes are managed in the external system.'}
              </p>
              <dl>
                <div>
                  <dt>Supplier</dt>
                  <dd>{order.supplierName}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <WorkspaceDate value={order.createdAt} />
                  </dd>
                </div>
                <div>
                  <dt>Order ID</dt>
                  <dd>
                    <code>{order.id}</code>
                  </dd>
                </div>
              </dl>
            </div>
          </section>
          {allowedTransitions.length > 0 && (
            <section className="procurement-panel">
              <div className="procurement-panel-heading">
                <h2>Next step</h2>
              </div>
              <div className="procurement-panel-body">
                <p>
                  {order.status === 'draft'
                    ? 'Review the supplier and quantities before opening this order.'
                    : 'Close a completed order or cancel it if it is no longer needed.'}
                </p>
                <div className="procurement-actions">
                  {allowedTransitions.map((status) => (
                    <Button
                      key={status}
                      variant={status === 'cancelled' ? 'outline' : 'default'}
                      onClick={() => setTransition(status)}
                    >
                      {status === 'open'
                        ? 'Open order'
                        : status === 'closed'
                          ? 'Close order'
                          : 'Cancel order'}
                    </Button>
                  ))}
                </div>
              </div>
            </section>
          )}
          <section className="procurement-panel">
            <div className="procurement-panel-heading">
              <h2>
                <Link2 size={16} />
                References
              </h2>
            </div>
            <div className="procurement-panel-body">
              {order.externalReferences.length ? (
                <dl>
                  {order.externalReferences.map((ref, index) => (
                    <div key={index}>
                      <dt>{ref.system}</dt>
                      <dd>
                        <code>{ref.externalId}</code>
                        {ref.connectionId && (
                          <p>
                            Connection <code>{ref.connectionId}</code>
                          </p>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>No external references.</p>
              )}
              {Object.keys(order.origin).length > 0 ? (
                <dl>
                  {Object.entries(order.origin).map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        {key === 'workflowRunId'
                          ? 'Workflow run'
                          : key === 'actionId'
                            ? 'Action'
                            : 'Outcome'}
                      </dt>
                      <dd>
                        <code>{value}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>Created directly in this workspace.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
      {transition && (
        <TransitionDialog
          key={`${order.id}:${order.revision}:${transition}`}
          organizationId={organizationId}
          order={order}
          status={transition}
          close={() => setTransition(null)}
        />
      )}
    </div>
  );
}
