/** Reads one page per permitted capability. Reuse cursors across passes to cover later orders without delaying other checks; failures restart that capability's scan. */
export async function observeProviders({
  context,
  installations,
  capabilities,
  recordRead,
  manifest,
  cursors,
  onError,
}) {
  const actor = await context();
  const connections = await installations.list(actor);
  for (const connection of connections) {
    if (
      !Object.values(manifest.connections).includes(connection.id) ||
      connection.status !== 'active'
    )
      continue;
    for (const capability of connection.permissions) {
      if (
        !capability.endsWith('.read') ||
        !connection.granted.includes(capability)
      )
        continue;
      const key = `${connection.id}:${capability}`;
      try {
        const paginated = ['orders.read', 'fulfillment.read'].includes(
          capability,
        );
        const progress = cursors.get(key) ?? { cursor: null, seen: new Set() };
        const result = await capabilities.read(actor, {
          connectionId: connection.id,
          capability,
          version: '0',
          input: {
            limit: capability === 'orders.shipping-method.read' ? 1 : 100,
            ...(progress.cursor ? { cursor: progress.cursor } : {}),
            ...(capability === 'orders.shipping-method.read'
              ? { order: { externalId: '10', scopeKey: '' } }
              : {}),
          },
        });
        await recordRead(actor, connection.id, capability, result);
        const cursor = paginated && result.ok ? result.value.nextCursor : null;
        if (cursor) {
          if (progress.seen.has(cursor) || progress.seen.size >= 100)
            throw new Error('Simulator observation pagination did not finish');
          progress.seen.add(cursor);
          cursors.set(key, { cursor, seen: progress.seen });
        } else cursors.delete(key);
      } catch (error) {
        cursors.delete(key);
        onError(error);
      }
    }
  }
}

/** Starts serial observation passes immediately and every ten seconds; stopping drains the current pass. */
export function startObservations(observe, onError) {
  let stopped = false;
  let timer;
  let pending;
  const tick = () => {
    pending = Promise.resolve()
      .then(observe)
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 10000);
      });
  };
  tick();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
