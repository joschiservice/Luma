import type { HomeModule, HomeModuleId } from '@luma/api-contract';
import {
  Activity,
  ChartNoAxesColumn,
  CircleCheckBig,
  Gauge,
  Inbox,
  type LucideIcon,
  Package,
  Plug,
  ShoppingBag,
  Undo2,
} from 'lucide-react';
import { z } from 'zod';

export const homeSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
});

export type HomeWindow = z.infer<typeof homeSearch>['window'];

/** What each Home module shows, for headings and the module picker. */
export const homeModules: Record<
  HomeModuleId,
  {
    title: string;
    description: string;
    size: HomeModule['size'];
    Icon: LucideIcon;
  }
> = {
  attention: {
    title: 'Needs your attention',
    description: 'Decisions and approvals waiting for you, most urgent first.',
    size: 'full',
    Icon: Inbox,
  },
  handling: {
    title: 'Luma is handling',
    description:
      'Issues Luma is investigating, fixing or checking without you.',
    size: 'half',
    Icon: CircleCheckBig,
  },
  connections: {
    title: 'Connected systems',
    description: 'Whether each connected system is sending recent data.',
    size: 'half',
    Icon: Plug,
  },
  activity: {
    title: 'Recent activity',
    description:
      'The latest decisions, actions and verifications in this workspace.',
    size: 'full',
    Icon: Activity,
  },
  outcomes: {
    title: 'Resolution outcomes',
    description:
      'Verified resolutions and how many Luma resolved without help.',
    size: 'half',
    Icon: Gauge,
  },
  'operational-metrics': {
    title: 'Operational pulse',
    description:
      'Live counts across issues, monitored stock, purchase orders and connections.',
    size: 'full',
    Icon: ChartNoAxesColumn,
  },
  'order-metrics': {
    title: 'Order flow',
    description: 'Order volume and fulfillment timing for a chosen period.',
    size: 'full',
    Icon: ShoppingBag,
  },
  catalog: {
    title: 'Catalog health',
    description:
      'SKUs whose store and ERP listings disagree, are missing or are not linked.',
    size: 'half',
    Icon: Package,
  },
  returns: {
    title: 'Returns',
    description:
      'Return requests to review, returns ready to refund or close, and failed refund payments.',
    size: 'half',
    Icon: Undo2,
  },
};

/** The Home a member sees until they customize it. */
export const defaultHome: HomeModule[] = [
  { id: 'attention', size: 'full' },
  { id: 'handling', size: 'half' },
  { id: 'connections', size: 'half' },
  { id: 'activity', size: 'full' },
];

/** Moves a module one place earlier or later, keeping the list unchanged at the edges. */
export function moveModule(
  modules: HomeModule[],
  id: HomeModuleId,
  offset: -1 | 1,
) {
  const index = modules.findIndex((module) => module.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= modules.length) return modules;
  const next = [...modules];
  [next[index], next[target]] = [next[target]!, next[index]!];

  return next;
}

/** Moves a module to the position of another module, for drag and drop. */
export function placeModule(
  modules: HomeModule[],
  id: HomeModuleId,
  before: HomeModuleId,
) {
  const moving = modules.find((module) => module.id === id);
  if (!moving || id === before) return modules;
  const rest = modules.filter((module) => module.id !== id);
  const index = rest.findIndex((module) => module.id === before);
  rest.splice(index < 0 ? rest.length : index, 0, moving);

  return rest;
}
