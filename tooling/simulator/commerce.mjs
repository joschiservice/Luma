/** Records simulated commerce observations and binds orders using the run's explicit cross-provider mappings. */
export async function recordSimulatorCommerce({
  commerce,
  context,
  manifest,
  capability,
  observations,
}) {
  if (!manifest.simulator) throw new Error('A simulator run is required');
  for (const { source } of observations) {
    if (
      source.tenantId !== manifest.organizationId ||
      source.connectionId !== manifest.connections[source.provider]
    )
      throw new Error('Observation is outside the simulator workspace');
  }
  let mappings = [];
  if (capability === 'orders.read' && observations.length) {
    const { endpoint, token, runId } = manifest.simulator;
    const response = await fetch(
      `${endpoint}/api/runs/${encodeURIComponent(runId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error('Simulator order mappings unavailable');
    const run = await response.json();
    if (run.id !== runId || !Array.isArray(run.mappings))
      throw new Error('Invalid simulator order mappings');
    mappings = run.mappings;
  }

  for (const observation of observations) {
    const ingestKey = `simulator:${observation.id}`;
    const input = { capability, observation };
    if (capability === 'inventory.read') {
      await commerce.ingestion.ingest(context, ingestKey, input);
      continue;
    }
    await commerce.sources.record(context, ingestKey, input);
    const { source } = observation;
    const bind = async (identity, sharedOrder) => {
      if (await commerce.sources.resolve(context, identity)) return;
      const key = JSON.stringify([
        'simulator',
        manifest.simulator.runId,
        ...(sharedOrder
          ? ['mapped-order', sharedOrder]
          : [
              identity.connectionId,
              identity.resource,
              identity.scopeKey,
              identity.externalId,
            ]),
      ]);
      await commerce.ingestion.bind(
        context,
        identity,
        key,
        observation.id,
        'Explicit simulator order mapping; unmapped records retain source-local identity',
      );
    };
    const mapping =
      capability === 'orders.read'
        ? mappings.find((entry) => entry[source.provider] === source.externalId)
        : undefined;
    await bind(source, mapping?.jtl);
    if (capability === 'orders.read')
      for (const line of observation.data.lines)
        await bind({ ...source, ...line.id, resource: 'order_line' });
    await commerce.ingestion.replay(context, source.connectionId, ingestKey);
  }
}
