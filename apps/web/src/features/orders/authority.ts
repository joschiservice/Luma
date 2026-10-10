import type { AuthorityGroup, FactAuthority } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

export const authorityGroupLabels: Record<AuthorityGroup, () => string> = {
  order_lines: m.orders_authority_lines,
  order_lifecycle: m.orders_authority_lifecycle,
  order_fulfillment: m.orders_authority_fulfillment,
  order_tracking: m.orders_authority_tracking,
  inventory_stock: m.orders_authority_stock,
  inventory_selling: m.orders_authority_selling,
};

/** Labels authority without presenting unknown or conflicting sources as authoritative. */
export function authorityLabel(
  fact: FactAuthority | undefined,
  connections: readonly { id: string; label: string }[],
) {
  if (!fact || fact.state === 'unknown') return m.orders_authority_unknown();
  if (fact.state === 'conflicting') return m.orders_authority_conflicting();
  const source =
    connections.find((connection) => connection.id === fact.connectionId)
      ?.label ?? m.orders_authority_missing();

  return fact.basis === 'override'
    ? m.orders_authority_override({ source })
    : m.orders_authority_default({ source });
}
