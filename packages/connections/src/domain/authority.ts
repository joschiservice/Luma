import type { InstallationCapability } from './installation.js';

export const authorityGroups = [
  'order_lines',
  'order_lifecycle',
  'order_fulfillment',
  'order_tracking',
  'inventory_stock',
  'inventory_selling',
] as const;

export type AuthorityGroup = (typeof authorityGroups)[number];

export interface AuthorityConnection {
  id: string;
  label: string;
  category: 'storefront' | 'erp' | null;
  available: boolean;
  capabilities: InstallationCapability[];
}

export interface FactAuthority {
  group: AuthorityGroup;
  state: 'resolved' | 'unknown' | 'conflicting';
  basis: 'default' | 'override';
  connectionId: string | null;
  overrideConnectionId: string | null;
  candidateIds: string[];
  eligibleIds: string[];
}

export type AuthorityOverrides = Partial<Record<AuthorityGroup, string>>;

const rules: Record<
  AuthorityGroup,
  {
    categories: AuthorityConnection['category'][];
    capability: InstallationCapability;
  }
> = {
  order_lines: { categories: ['storefront', 'erp'], capability: 'orders.read' },
  order_lifecycle: {
    categories: ['storefront', 'erp'],
    capability: 'orders.read',
  },
  order_fulfillment: {
    categories: ['erp', 'storefront'],
    capability: 'fulfillment.read',
  },
  order_tracking: {
    categories: ['erp', 'storefront'],
    capability: 'fulfillment.read',
  },
  inventory_stock: { categories: ['erp'], capability: 'inventory.read' },
  inventory_selling: {
    categories: ['storefront'],
    capability: 'inventory.read',
  },
};

/** Whether this connection can supply this fact; stock selling sources must be storefronts. */
export function eligibleAuthority(
  group: AuthorityGroup,
  connection: AuthorityConnection,
) {
  return (
    connection.available &&
    connection.capabilities.includes(rules[group].capability) &&
    (group !== 'inventory_selling' || connection.category === 'storefront')
  );
}

/** Resolves workspace authority without choosing among equally eligible connections or replacing an unavailable override. */
export function resolveAuthority(
  group: AuthorityGroup,
  connections: readonly AuthorityConnection[],
  overrides: AuthorityOverrides,
): FactAuthority {
  const overrideConnectionId = overrides[group] ?? null;
  const eligible = connections.filter((connection) =>
    eligibleAuthority(group, connection),
  );
  const candidates = overrideConnectionId
    ? eligible.filter((connection) => connection.id === overrideConnectionId)
    : (rules[group].categories
        .map((category) =>
          eligible.filter((connection) => connection.category === category),
        )
        .find((items) => items.length > 0) ?? []);

  return {
    group,
    state:
      candidates.length === 1
        ? 'resolved'
        : candidates.length > 1
          ? 'conflicting'
          : 'unknown',
    basis: overrideConnectionId ? 'override' : 'default',
    connectionId: candidates.length === 1 ? candidates[0]!.id : null,
    overrideConnectionId,
    eligibleIds: eligible.map((connection) => connection.id).sort(),
    candidateIds: candidates.map((connection) => connection.id).sort(),
  };
}
