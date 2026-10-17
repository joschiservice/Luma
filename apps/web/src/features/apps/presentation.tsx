import type { AppManifest, InstalledConnection } from '@luma/api-contract';
import { formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import {
  type LucideIcon,
  Mail,
  Plug,
  Store,
  Truck,
  Warehouse,
  Wrench,
} from 'lucide-react';
import { useContext } from 'react';

import { connectionState } from '../../kit/connections/presentation';
import { useNow } from '../../kit/live/now';

const categories: Record<
  AppManifest['category'],
  { label: () => string; Icon: LucideIcon }
> = {
  storefront: { label: m.apps_category_storefront, Icon: Store },
  erp: { label: m.apps_category_erp, Icon: Warehouse },
  shipping: { label: m.apps_category_shipping, Icon: Truck },
  communication: { label: m.apps_category_communication, Icon: Mail },
  utility: { label: m.apps_category_utility, Icon: Wrench },
};

/** Names the kind of system an app connects, such as Storefront or ERP. */
export function appCategoryLabel(category: AppManifest['category']) {
  return categories[category].label();
}

/**
 * Marks an app by the kind of system it connects. External systems stay neutral, so the tile
 * carries no provider branding; an app missing from the catalog shows a plug.
 */
export function AppIcon({
  category,
  size = 'md',
}: {
  category?: AppManifest['category'] | undefined;
  size?: 'md' | 'lg';
}) {
  const Icon = category ? categories[category].Icon : Plug;

  return (
    <span className="app-icon" data-size={size} aria-hidden="true">
      <Icon />
    </span>
  );
}

/**
 * Summarizes the connections of one app for the overview: the live connections, those that
 * need someone to act, and one state with a label. Disconnected connections are history and
 * count toward neither.
 */
export function appConnectionSummary(connections: InstalledConnection[]): {
  live: InstalledConnection[];
  attention: InstalledConnection[];
  state: OperationalState;
  label: string;
} {
  const live = connections.filter((item) => item.status !== 'disconnected');
  const states = new Map(live.map((item) => [item, connectionState(item)]));
  const attention = live.filter((item) => states.get(item)!.attention);
  if (!live.length)
    return {
      live,
      attention,
      state: 'idle',
      label: m.apps_store_connections_empty(),
    };
  if (attention.length)
    return {
      live,
      attention,
      state: attention.some((item) => states.get(item)!.state === 'error')
        ? 'error'
        : 'attention',
      label: m.apps_store_connections_attention({ count: attention.length }),
    };
  const all = [...states.values()];
  const importing = all.find((item) => item.state !== 'verified');

  return {
    live,
    attention,
    state: importing?.state ?? 'verified',
    label: importing?.label ?? m.apps_store_connections_healthy(),
  };
}

/** How long ago something happened, naming the exact moment in workspace time on hover. */
export function RelativeTime({ value }: { value: string }) {
  const timeZone = useContext(WorkspaceTimezone);
  const now = useNow();

  return (
    <time dateTime={value} title={formatWorkspaceInstant(value, timeZone)}>
      {formatRelativeTime(value, Math.max(now, Date.parse(value)))}
    </time>
  );
}
