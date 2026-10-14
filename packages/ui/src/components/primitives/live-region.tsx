import { m } from '@luma/i18n/messages';
import { useState } from 'react';

/**
 * Announces `message` politely to assistive technology without showing it. Changing the
 * message announces it; an unchanged message is not repeated.
 */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div role="status" className="sr-only">
      {message}
    </div>
  );
}

/**
 * Announces how many rows are selected after the selection changes, such as after Shift+X or
 * selecting a whole page. Nothing is announced when the list first renders.
 */
export function SelectionAnnouncement({ count }: { count: number }) {
  const [announced, setAnnounced] = useState(count);
  const [message, setMessage] = useState('');
  if (announced !== count) {
    setAnnounced(count);
    setMessage(
      count ? m.ui_selection_count({ count }) : m.ui_selection_cleared(),
    );
  }

  return <LiveRegion message={message} />;
}
