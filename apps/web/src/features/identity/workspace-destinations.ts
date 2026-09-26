import {
  Activity,
  BookOpen,
  Inbox,
  LayoutDashboard,
  Settings,
  Unplug,
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
    path: 'playbooks',
    label: 'Playbooks',
    Icon: BookOpen,
    description: 'Manage resolution playbooks',
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
