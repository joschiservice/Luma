import {
  Activity,
  Blocks,
  Boxes,
  Factory,
  Inbox,
  type LucideIcon,
  Receipt,
  ShoppingCart,
  Truck,
  Workflow,
} from 'lucide-react';

import { cn } from '../../lib/utils';

/** Operational areas that receive a recognizable landmark color in navigation. */
export type Domain =
  | 'orders'
  | 'inventory'
  | 'procurement'
  | 'suppliers'
  | 'fulfillment'
  | 'workflows'
  | 'issues'
  | 'activity'
  | 'apps';

const domainIcons: Record<Domain, LucideIcon> = {
  orders: Receipt,
  inventory: Boxes,
  procurement: ShoppingCart,
  suppliers: Factory,
  fulfillment: Truck,
  workflows: Workflow,
  issues: Inbox,
  activity: Activity,
  apps: Blocks,
};

/**
 * Shows a domain landmark: a solid tile in the domain color with a white glyph.
 * Use for navigation and record identity, never for state. Decorative by default.
 */
export function DomainIcon({
  domain,
  icon,
  size = 'md',
  className,
}: {
  domain: Domain;
  icon?: LucideIcon;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const Icon = icon ?? domainIcons[domain];

  return (
    <span
      aria-hidden="true"
      data-domain={domain}
      data-size={size}
      className={cn('lu-domain-icon', className)}
    >
      <Icon strokeWidth={2.1} />
    </span>
  );
}
