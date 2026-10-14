import { useEffect, useEffectEvent, useState } from 'react';

/**
 * Search text of a list whose search can match personal data, such as customer names or email
 * addresses (catalog `search: 'private'`). The text lives in page state only: never in the
 * URL, saved views, remembered list state or browser storage, so it is gone after a reload.
 * A link may still open the list with `?q=`, such as a SKU from a product: the page adopts
 * that text, and `dropFromUrl` removes it from the address with a replace. A later link with
 * `?q=` replaces the current text.
 */
export function usePrivateSearch(
  incoming: string | undefined,
  dropFromUrl: () => void,
): [string, (q: string) => void] {
  const [q, setQ] = useState(incoming ?? '');
  const [link, setLink] = useState(incoming);
  if (incoming !== link) {
    setLink(incoming);
    if (incoming !== undefined) setQ(incoming);
  }
  const drop = useEffectEvent(dropFromUrl);
  useEffect(() => {
    if (incoming !== undefined) drop();
  }, [incoming]);

  return [q, setQ];
}
