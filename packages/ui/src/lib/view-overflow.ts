/**
 * Chooses which views stay visible in a row of `available` pixels. Views keep their order and
 * the first ones that fit are shown; when any view overflows, the More trigger takes `more`
 * pixels. The `current` view is always shown, in place of the last views that fit when it would
 * otherwise overflow, so the open view never hides behind More. Returns the shown indices in
 * display order.
 */
export function fitViews({
  widths,
  available,
  more,
  current,
}: {
  widths: readonly number[];
  available: number;
  more: number;
  current?: number | undefined;
}): number[] {
  const all = widths.map((_, index) => index);
  const width = (indices: readonly number[]) =>
    indices.reduce((sum, index) => sum + (widths[index] ?? 0), 0);
  if (width(all) <= available) return all;

  const room = available - more;
  const shown: number[] = [];
  for (const index of all) {
    if (width([...shown, index]) > room) break;
    shown.push(index);
  }
  if (current === undefined || !(current in widths) || shown.includes(current))
    return shown;

  while (shown.length && width([...shown, current]) > room) shown.pop();

  return [...shown, current];
}
