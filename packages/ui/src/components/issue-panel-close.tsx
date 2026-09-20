import { X } from 'lucide-react';

import { Button } from './button';

/** Provides an accessible icon control that closes the inspector. */
export function IssuePanelClose({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="issue-panel-close"
      onClick={onClose}
      aria-keyshortcuts="Escape"
      aria-label="Close panel"
      title="Close panel (Esc)"
    >
      <X aria-hidden="true" />
    </Button>
  );
}
