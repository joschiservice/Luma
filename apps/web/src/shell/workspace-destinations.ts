import { m } from '@luma/i18n/messages';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import {
  Activity,
  Blocks,
  Boxes,
  ChartNoAxesColumn,
  Columns3,
  Database,
  DatabaseZap,
  Hand,
  House,
  Inbox,
  type LucideIcon,
  Mail,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Truck,
  Undo2,
  Users,
  Workflow,
} from 'lucide-react';

/** Where a destination appears in the sidebar. */
type DestinationGroup = 'core' | 'operations' | 'workspace';

/** Workspace route segments that appear in navigation. */
type DestinationPath =
  | 'views'
  | 'home'
  | 'needs-you'
  | 'exceptions'
  | 'activity'
  | 'insights'
  | 'inbox'
  | 'orders'
  | 'customers'
  | 'products'
  | 'returns'
  | 'inventory'
  | 'fulfillment'
  | 'workflows'
  | 'procurement'
  | 'apps'
  | 'sync'
  | 'settings'
  | 'records';

export type WorkspaceDestination = {
  path: DestinationPath;
  /** The localized page name, read in the active language each time. */
  readonly label: string;
  Icon: LucideIcon;
  /** A localized one-line summary of the page, read in the active language each time. */
  readonly description: string;
  group: DestinationGroup;
  /** Domain landmark shown instead of a functional icon. */
  domain?: Domain;
  /** Second key of the `G` navigation shortcut, such as `h` for G then H. */
  shortcut: string;
  /** The permission needed to open the page; without one, every member can open it. */
  permission?: string;
  /** What the page shows, for the no-access explanation, in the active language. */
  readonly area?: string | undefined;
};

type DestinationInput = Omit<
  WorkspaceDestination,
  'label' | 'description' | 'area'
> & {
  label: () => string;
  description: () => string;
  area?: () => string;
};

/**
 * Keeps a destination's text as getters so module-level navigation data still renders in the
 * language of each request.
 */
function destination({
  label,
  description,
  area,
  ...rest
}: DestinationInput): WorkspaceDestination {
  return {
    ...rest,
    get label() {
      return label();
    },
    get description() {
      return description();
    },
    get area() {
      return area?.();
    },
  };
}

/** Pages available through workspace navigation, search and `G` shortcuts. */
export const workspaceDestinations: readonly WorkspaceDestination[] = [
  destination({
    path: 'home',
    label: m.identity_nav_home,
    Icon: House,
    description: m.identity_nav_home_description,
    group: 'core',
    shortcut: 'h',
  }),
  destination({
    path: 'needs-you',
    label: m.identity_nav_needs_you,
    Icon: Hand,
    description: m.identity_nav_needs_you_description,
    group: 'core',
    shortcut: 'n',
  }),
  destination({
    path: 'exceptions',
    label: m.identity_nav_issues,
    Icon: Inbox,
    description: m.identity_nav_issues_description,
    group: 'core',
    shortcut: 'i',
    permission: 'issues.read',
    area: m.identity_nav_issues_area,
  }),
  destination({
    path: 'records',
    label: m.identity_nav_records,
    Icon: Database,
    description: m.identity_nav_records_description,
    group: 'core',
    shortcut: 'r',
  }),
  destination({
    path: 'views',
    label: m.adaptive_title,
    Icon: Columns3,
    description: m.adaptive_description,
    group: 'core',
    shortcut: 'v',
    area: m.adaptive_title,
  }),
  destination({
    path: 'activity',
    label: m.identity_nav_activity,
    Icon: Activity,
    description: m.identity_nav_activity_description,
    group: 'core',
    shortcut: 'a',
    permission: 'activity.read',
    area: m.identity_nav_activity_area,
  }),
  destination({
    path: 'insights',
    label: m.identity_nav_insights,
    Icon: ChartNoAxesColumn,
    description: m.identity_nav_insights_description,
    group: 'core',
    shortcut: 'm',
    permission: 'insights.read',
    area: m.identity_nav_insights_area,
  }),
  destination({
    path: 'inbox',
    label: m.identity_nav_inbox,
    Icon: Mail,
    description: m.identity_nav_inbox_description,
    group: 'operations',
    shortcut: 'e',
    permission: 'messages.read',
    area: m.identity_nav_inbox_area,
  }),
  destination({
    path: 'orders',
    label: m.identity_nav_orders,
    Icon: Receipt,
    description: m.identity_nav_orders_description,
    group: 'operations',
    domain: 'orders',
    shortcut: 'o',
    permission: 'orders.read',
    area: m.identity_nav_orders_area,
  }),
  destination({
    path: 'customers',
    label: m.identity_nav_customers,
    Icon: Users,
    description: m.identity_nav_customers_description,
    group: 'operations',
    domain: 'customers',
    shortcut: 'u',
    permission: 'customers.read',
    area: m.identity_nav_customers_area,
  }),
  destination({
    path: 'products',
    label: m.identity_nav_products,
    Icon: Package,
    description: m.identity_nav_products_description,
    group: 'operations',
    domain: 'products',
    shortcut: 'k',
    permission: 'products.read',
    area: m.identity_nav_products_area,
  }),
  destination({
    path: 'returns',
    label: m.identity_nav_returns,
    Icon: Undo2,
    description: m.identity_nav_returns_description,
    group: 'operations',
    domain: 'returns',
    shortcut: 't',
    permission: 'returns.read',
    area: m.identity_nav_returns_area,
  }),
  destination({
    path: 'inventory',
    label: m.identity_nav_inventory,
    Icon: Boxes,
    description: m.identity_nav_inventory_description,
    group: 'operations',
    domain: 'inventory',
    shortcut: 'y',
    permission: 'inventory.read',
    area: m.identity_nav_inventory_area,
  }),
  destination({
    path: 'fulfillment',
    label: m.identity_nav_fulfillment,
    Icon: Truck,
    description: m.identity_nav_fulfillment_description,
    group: 'operations',
    domain: 'fulfillment',
    shortcut: 'f',
    permission: 'fulfillment.read',
    area: m.identity_nav_fulfillment_area,
  }),
  destination({
    path: 'workflows',
    label: m.identity_nav_workflows,
    Icon: Workflow,
    description: m.identity_nav_workflows_description,
    group: 'operations',
    domain: 'workflows',
    shortcut: 'w',
    permission: 'workflows.read',
    area: m.identity_nav_workflows_area,
  }),
  destination({
    path: 'procurement',
    label: m.identity_nav_procurement,
    Icon: ShoppingCart,
    description: m.identity_nav_procurement_description,
    group: 'operations',
    domain: 'procurement',
    shortcut: 'p',
    permission: 'procurement.read',
    area: m.identity_nav_procurement_area,
  }),
  destination({
    path: 'apps',
    label: m.identity_nav_apps,
    Icon: Blocks,
    description: m.identity_nav_apps_description,
    group: 'workspace',
    shortcut: 'c',
  }),
  destination({
    path: 'sync',
    label: m.identity_nav_sync,
    Icon: DatabaseZap,
    description: m.identity_nav_sync_description,
    group: 'workspace',
    shortcut: 'd',
  }),
  destination({
    path: 'settings',
    label: m.identity_nav_settings,
    Icon: Settings,
    description: m.identity_nav_settings_description,
    group: 'workspace',
    shortcut: 's',
  }),
];

/** Finds the destination that owns a workspace URL, defaulting to Home. */
export function destinationFor(pathname: string) {
  const section = pathname.split(/[?#]/)[0]?.split('/')[3];
  const normalized =
    section === 'overview'
      ? 'home'
      : section === 'connections'
        ? 'apps'
        : section === 'playbooks'
          ? 'workflows'
          : section;

  return (
    workspaceDestinations.find(({ path }) => path === normalized) ??
    workspaceDestinations[0]!
  );
}
