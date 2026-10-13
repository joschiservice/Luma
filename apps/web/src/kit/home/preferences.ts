import type { HomeModule, HomeModuleId } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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
  Truck,
  Undo2,
} from 'lucide-react';
import { z } from 'zod';

export const homeSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
  start: z.string().datetime().optional().catch(undefined),
  end: z.string().datetime().optional().catch(undefined),
});

export type HomeWindow = z.infer<typeof homeSearch>['window'];

/**
 * What each Home module shows, for headings and the module picker. Titles and descriptions are
 * getters, so each read returns text in the active language.
 */
export const homeModules: Record<
  HomeModuleId,
  {
    readonly title: string;
    readonly description: string;
    size: HomeModule['size'];
    Icon: LucideIcon;
  }
> = {
  'saved-views': {
    get title() {
      return m.adaptive_title();
    },
    get description() {
      return m.adaptive_description();
    },
    size: 'half',
    Icon: ChartNoAxesColumn,
  },
  attention: {
    get title() {
      return m.home_module_attention_title();
    },
    get description() {
      return m.home_module_attention_description();
    },
    size: 'full',
    Icon: Inbox,
  },
  handling: {
    get title() {
      return m.home_module_handling_title();
    },
    get description() {
      return m.home_module_handling_description();
    },
    size: 'half',
    Icon: CircleCheckBig,
  },
  connections: {
    get title() {
      return m.home_module_connections_title();
    },
    get description() {
      return m.home_module_connections_description();
    },
    size: 'half',
    Icon: Plug,
  },
  activity: {
    get title() {
      return m.home_module_activity_title();
    },
    get description() {
      return m.home_module_activity_description();
    },
    size: 'full',
    Icon: Activity,
  },
  outcomes: {
    get title() {
      return m.home_module_outcomes_title();
    },
    get description() {
      return m.home_module_outcomes_description();
    },
    size: 'half',
    Icon: Gauge,
  },
  'operational-metrics': {
    get title() {
      return m.home_module_operational_metrics_title();
    },
    get description() {
      return m.home_module_operational_metrics_description();
    },
    size: 'full',
    Icon: ChartNoAxesColumn,
  },
  'order-metrics': {
    get title() {
      return m.home_module_order_metrics_title();
    },
    get description() {
      return m.home_module_order_metrics_description();
    },
    size: 'full',
    Icon: ShoppingBag,
  },
  catalog: {
    get title() {
      return m.home_module_catalog_title();
    },
    get description() {
      return m.home_module_catalog_description();
    },
    size: 'half',
    Icon: Package,
  },
  fulfillment: {
    get title() {
      return m.home_module_fulfillment_title();
    },
    get description() {
      return m.home_module_fulfillment_description();
    },
    size: 'half',
    Icon: Truck,
  },
  returns: {
    get title() {
      return m.home_module_returns_title();
    },
    get description() {
      return m.home_module_returns_description();
    },
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
