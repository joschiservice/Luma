import { LumaMark } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import { useEffect, useSyncExternalStore } from 'react';

import {
  readAssistantOpen,
  setAssistantOpen,
  useAssistantOpen,
} from '../../lib/assistant-panel';
import { usesCommandKey } from '../../lib/keyboard';

const subscribePlatform = () => () => undefined;
const platformModifier = () => (usesCommandKey() ? '⌘' : 'Ctrl');

/** Opens and closes the Ask Luma panel with ⌘J or Ctrl J, including from text fields. */
export function useAssistantShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'j'
      )
        return;
      event.preventDefault();
      setAssistantOpen(!readAssistantOpen());
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** The top bar button that opens and closes the Ask Luma panel. */
export function AssistantToggle() {
  const open = useAssistantOpen();
  const modifier = useSyncExternalStore(
    subscribePlatform,
    platformModifier,
    () => 'Ctrl',
  );

  return (
    <Button
      variant="ghost"
      size="sm"
      className="assistant-toggle"
      aria-pressed={open}
      aria-controls="assistant-panel"
      title={`${open ? 'Close' : 'Ask'} Luma (${modifier} J)`}
      onClick={() => setAssistantOpen(!open)}
    >
      <LumaMark
        tone={open ? 'color' : 'mono'}
        className="assistant-toggle-mark"
      />
      <span className="assistant-toggle-label">Ask Luma</span>
    </Button>
  );
}
