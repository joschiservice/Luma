/** Reads each permitted capability through the installed runtime and stores its outcome. Failures in one capability do not stop other reads. */
export async function observeProviders({
  context,
  installations,
  capabilities,
  recordRead,
  manifest,
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
      try {
        // Coverage needs a current sample, not an exhaustive synchronization of provider history.
        const result = await capabilities.read(actor, {
          connectionId: connection.id,
          capability,
          version: '0',
          input: {
            limit: capability === 'orders.shipping-method.read' ? 1 : 100,
            ...(capability === 'orders.shipping-method.read'
              ? { order: { externalId: '10', scopeKey: '' } }
              : {}),
          },
        });
        await recordRead(actor, connection.id, capability, result);
      } catch (error) {
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
