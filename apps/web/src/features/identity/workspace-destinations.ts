import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import {
  Activity,
  Blocks,
  ChartNoAxesColumn,
  Database,
  House,
  Inbox,
  type LucideIcon,
  Receipt,
  Settings,
  ShoppingCart,
  Users,
  Workflow,
} from 'lucide-react';

/** Where a destination appears in the sidebar. */
export type DestinationGroup = 'core' | 'operations' | 'workspace';

/** Workspace route segments that appear in navigation. */
export type DestinationPath =
  | 'home'
  | 'exceptions'
  | 'activity'
  | 'insights'
  | 'orders'
  | 'customers'
  | 'workflows'
  | 'procurement'
  | 'apps'
  | 'settings'
  | 'records';

export type WorkspaceDestination = {
  path: DestinationPath;
  label: string;
  Icon: LucideIcon;
  description: string;
  group: DestinationGroup;
  /** Domain landmark shown instead of a functional icon. */
  domain?: Domain;
  /** Second key of the `G` navigation shortcut, such as `h` for G then H. */
  shortcut: string;
};

/** Pages available through workspace navigation, search and `G` shortcuts. */
export const workspaceDestinations: readonly WorkspaceDestination[] = [
  {
    path: 'home',
    label: 'Home',
    Icon: House,
    description: 'What needs your attention and what Luma is handling',
    group: 'core',
    shortcut: 'h',
  },
  {
    path: 'exceptions',
    label: 'Issues',
    Icon: Inbox,
    description: 'Investigate and resolve issues',
    group: 'core',
    shortcut: 'i',
  },
  {
    path: 'records',
    label: 'Records',
    Icon: Database,
    description: 'Search orders, stock, fulfillments and related records',
    group: 'core',
    shortcut: 'r',
  },
  {
    path: 'activity',
    label: 'Activity',
    Icon: Activity,
    description: 'Follow workspace activity',
    group: 'core',
    shortcut: 'a',
  },
  {
    path: 'insights',
    label: 'Insights',
    Icon: ChartNoAxesColumn,
    description: 'Live operational metrics and order flow',
    group: 'core',
    shortcut: 'm',
  },
  {
    path: 'orders',
    label: 'Orders',
    Icon: Receipt,
    description: 'Search order history, fulfillment progress and source facts',
    group: 'operations',
    domain: 'orders',
    shortcut: 'o',
  },
  {
    path: 'customers',
    label: 'Customers',
    Icon: Users,
    description: 'Customer identity, order history and service context',
    group: 'operations',
    shortcut: 'u',
  },
  {
    path: 'workflows',
    label: 'Workflows',
    Icon: Workflow,
    description: 'Review and run the workflows behind your operations',
    group: 'operations',
    domain: 'workflows',
    shortcut: 'w',
  },
  {
    path: 'procurement',
    label: 'Procurement',
    Icon: ShoppingCart,
    description: 'Manage suppliers and purchase orders',
    group: 'operations',
    domain: 'procurement',
    shortcut: 'p',
  },
  {
    path: 'apps',
    label: 'Apps',
    Icon: Blocks,
    description: 'Install apps and manage connected systems',
    group: 'workspace',
    shortcut: 'c',
  },
  {
    path: 'settings',
    label: 'Settings',
    Icon: Settings,
    description: 'Workspace, team, notifications, and approvals',
    group: 'workspace',
    shortcut: 's',
  },
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
