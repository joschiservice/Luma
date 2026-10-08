import { m } from '@luma/i18n/messages';
import { X } from 'lucide-react';

import { Button } from '../primitives/button';

/** Provides an accessible icon control that closes the inspector. */
export function IssuePanelClose({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="issue-panel-close"
      onClick={onClose}
      aria-keyshortcuts="Escape"
      aria-label={m.issues_panel_close()}
      title={m.issues_panel_close_shortcut()}
    >
      <X aria-hidden="true" />
    </Button>
  );
}
