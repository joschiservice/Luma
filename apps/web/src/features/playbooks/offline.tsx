import { Alert } from '@luma/ui/components/primitives/alert';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const snapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Announces offline state while keeping previously loaded context visible. */
export function OfflineNotice() {
  const online = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  return online ? null : (
    <Alert tone="warning" role="status" className="playbook-notice">
      You are offline. Previously loaded information may be outdated. Reconnect
      and refresh before changing activations.
    </Alert>
  );
}
