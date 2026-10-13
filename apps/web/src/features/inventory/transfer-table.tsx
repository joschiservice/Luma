import type { TransferSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Link } from '@tanstack/react-router';

import { stockQuantity } from './presentation';
import {
  TransferEvidence,
  transferStates as states,
} from './transfer-presentation';

/** Displays bounded stage summaries with meaningful status and evidence labels. */
export function TransferTable({
  organizationId,
  items,
}: {
  organizationId: string;
  items: TransferSummary[];
}) {
  return (
    <DataTable
      caption={m.inventory_transfer_title()}
      rows={items}
      rowKey={(item) => `${item.id}/${item.connectionId}`}
      columns={[
        {
          key: 'name',
          header: m.inventory_transfer_record(),
          cell: (item: TransferSummary) => (
            <div className="inventory-cell">
              <TransferLink organizationId={organizationId} item={item} />
              <small>
                {item.label} ·{' '}
                {(states[item.status] ?? m.inventory_transfer_unknown)()}
              </small>
              <TransferEvidence item={item} />
            </div>
          ),
        },
        {
          key: 'route',
          header: m.inventory_transfer_route(),
          cell: (item) => (
            <span>
              {item.facts.origin ?? m.common_not_reported()} →{' '}
              {item.facts.destination ?? m.common_not_reported()}
            </span>
          ),
        },
        {
          key: 'requested',
          header: m.inventory_transfer_requested(),
          cell: (item) => stockQuantity(item.facts.requested),
        },
        {
          key: 'shipped',
          header: m.inventory_transfer_shipped(),
          cell: (item) => stockQuantity(item.facts.shipped),
        },
        {
          key: 'received',
          header: m.inventory_transfer_received(),
          cell: (item) => stockQuantity(item.facts.received),
        },
        {
          key: 'unreceived',
          header: m.inventory_transfer_unreceived(),
          cell: (item) => stockQuantity(item.facts.unreceived),
        },
      ]}
    />
  );
}

function TransferLink({
  organizationId,
  item,
}: {
  organizationId: string;
  item: TransferSummary;
}) {
  return (
    <Link
      to="/app/$organizationId/inventory/transfers/$transferId"
      params={{ organizationId, transferId: item.id }}
      search={{ connectionId: item.connectionId }}
    >
      {item.name}
    </Link>
  );
}
