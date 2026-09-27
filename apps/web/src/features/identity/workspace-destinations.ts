import {
  Activity,
  Inbox,
  LayoutDashboard,
  Settings,
  ShoppingBag,
  Unplug,
  Workflow,
} from 'lucide-react';

/** Pages available through workspace navigation and search. */
export const workspaceDestinations = [
  {
    path: 'overview',
    label: 'Overview',
    Icon: LayoutDashboard,
    description: 'Your operations at a glance',
  },
  {
    path: 'exceptions',
    label: 'Issues',
    Icon: Inbox,
    description: 'Investigate and resolve issues',
  },
  {
    path: 'workflows',
    label: 'Workflows',
    Icon: Workflow,
    description: 'Manage resolution workflows',
  },
  {
    path: 'procurement',
    label: 'Procurement',
    Icon: ShoppingBag,
    description: 'Manage suppliers and purchase orders',
  },
  {
    path: 'activity',
    label: 'Activity',
    Icon: Activity,
    description: 'Follow workspace activity',
  },
  {
    path: 'connections',
    label: 'Connections',
    Icon: Unplug,
    description: 'Manage connected systems',
  },
  {
    path: 'settings',
    label: 'Settings',
    Icon: Settings,
    description: 'Workspace, team, notifications, and approvals',
  },
] as const;
