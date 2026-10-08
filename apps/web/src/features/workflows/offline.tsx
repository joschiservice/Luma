import { m } from '@luma/i18n/messages';
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
    <Alert tone="warning" role="status" className="workflow-notice">
      {m.workflows_offline()}
    </Alert>
  );
}
