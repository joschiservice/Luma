import { m } from '@luma/i18n/messages';

import type { OperationalState } from '../components/primitives/state';

/** Presents the shared operational health independently of installation validation. */
export function connectionHealthLabel(health: string): {
  state: OperationalState;
  label: string;
} {
  const states: Record<
    string,
    { state: OperationalState; label: () => string }
  > = {
    healthy: { state: 'verified', label: m.connections_health_healthy },
    delayed: { state: 'attention', label: m.connections_health_delayed },
    failing: { state: 'error', label: m.connections_health_failing },
    access_lost: { state: 'error', label: m.connections_health_access_lost },
    importing: { state: 'waiting', label: m.connections_health_importing },
    disconnected: { state: 'idle', label: m.connections_health_disconnected },
  };
  const value = states[health] ?? states.importing!;

  return { state: value.state, label: value.label() };
}
