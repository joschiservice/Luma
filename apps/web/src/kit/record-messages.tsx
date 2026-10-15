import type { LinkedRecordKind } from '@luma/api-contract';
import { createContext, type ReactNode, useContext } from 'react';

/** What a record page passes to show the message threads linked to one of its records. */
export interface RecordMessagesProps {
  organizationId: string;
  kind: LinkedRecordKind;
  recordId: string;
  /**
   * Wraps the list in the record page's section, such as a card with the "Messages" title.
   * `empty` is true once the record is known to have no threads, so the page can show the
   * section's header alone.
   */
  frame: (content: ReactNode, empty: boolean) => ReactNode;
}

const RecordMessagesView = createContext<
  ((props: RecordMessagesProps) => ReactNode) | null
>(null);

/**
 * Supplies how record pages render linked message threads. The shell provides the inbox's view,
 * so record features show messages without depending on the inbox.
 */
export const RecordMessagesProvider = RecordMessagesView.Provider;

/** Shows a record's linked message threads; renders nothing where no view is provided. */
export function RecordMessages(props: RecordMessagesProps) {
  const render = useContext(RecordMessagesView);

  return render ? render(props) : null;
}
