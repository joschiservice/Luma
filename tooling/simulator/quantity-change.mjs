import { randomUUID } from 'node:crypto';

import { erpOf } from './erp.mjs';

/**
 * Carries out the customer requests the simulator records as `order-quantity-change` incidents,
 * as the merchant's support does in Luma: links the shop order with its ERP import and the line's
 * SKU, accepts the order into a Luma record, makes Luma ERP the order-line and lifecycle
 * authority and lowers the line in the record. The providers keep the original order, so Luma's
 * detection and workflow carry the change. Each pass handles active incidents and is safe to
 * repeat; an order that is not imported or linked yet waits for the next pass. Needs the
 * `luma-erp-orders` release.
 */
export function createQuantityChanges({
  commerce,
  application,
  operator,
  manifest,
}) {
  const simulator = manifest.simulator;
  if (!simulator) return { pass: async () => ({ changed: 0, waiting: 0 }) };
  const erp = erpOf(manifest);
  const done = new Set();
  const identity = (
    instance,
    provider,
    resource,
    externalId,
    scopeKey = '',
  ) => ({
    tenantId: manifest.organizationId,
    connectionId: manifest.connections[instance],
    provider,
    resource,
    externalId,
    scopeKey,
  });

  async function incidents() {
    const response = await fetch(
      `${simulator.endpoint}/api/runs/${simulator.runId}/incidents`,
      { headers: { authorization: `Bearer ${simulator.token}` } },
    );
    if (!response.ok) throw new Error('The simulator is unavailable');

    return (await response.json()).filter(
      (item) =>
        item.kind === 'order-quantity-change' && item.status === 'active',
    );
  }

  /** Links two imported records once; false while one is not imported yet. */
  async function link(context, kind, left, right, reason) {
    const [target, other] = await Promise.all([
      commerce.sources.resolve(context, left),
      commerce.sources.resolve(context, right),
    ]);
    if (!target || !other) return null;
    if (target !== other)
      await commerce.ingestion.link(context, kind, target, other, reason);

    return target;
  }

  /** Selects Luma ERP for a fact group unless it already holds it. */
  async function authority(context, group, connectionId) {
    const current = await application.http.sourceAuthority.read(context);
    if (
      current.groups.find((item) => item.group === group)?.connectionId ===
      connectionId
    )
      return;
    await application.http.sourceAuthority.change(context, {
      commandId: randomUUID(),
      revision: current.revision,
      group,
      connectionId,
    });
  }

  /**
   * Returns whether the request is now in Luma's record. The customer wants one unit less than
   * ordered, so repeating a pass never lowers the line again.
   */
  async function apply(context, incident) {
    const resource = (kind) =>
      incident.resources.find((item) => item.kind === kind)?.id;
    const [order, lineItem, erpOrder, item, erpItem] = [
      resource('Order'),
      resource('LineItem'),
      resource('salesOrder'),
      resource('InventoryItem'),
      resource('item'),
    ];
    const shop = incident.instance;
    if (!order || !lineItem || !erpOrder || !item || !erpItem || !shop)
      return false;
    const sales = application.http.sales;
    // Lines match across the shop and the ERP by their linked SKU.
    await link(
      context,
      'sku',
      identity(erp.name, erp.kind, 'sku', erpItem),
      identity(shop, 'shopify', 'sku', item),
      'The shop sells this ERP item',
    );
    const orderId = await link(
      context,
      'order',
      identity(shop, 'shopify', 'order', order),
      identity(erp.name, erp.kind, 'order', erpOrder),
      'The ERP order carries the shop order number',
    );
    if (!orderId) return false;
    const record =
      (await sales.get(context, orderId)) ??
      (await sales.accept(context, orderId, manifest.connections[shop]));
    for (const group of ['order_lifecycle', 'order_lines'])
      await authority(context, group, record.connectionId);
    // Luma's record keeps the shop's canonical line IDs.
    const lineId = await commerce.sources.resolve(
      context,
      identity(shop, 'shopify', 'order_line', lineItem, order),
    );
    const line = record.lines.find((item) => item.id === lineId);
    if (!line) return false;
    const target = String(Number(line.quantity) - 1);
    if (Number(line.currentQuantity) !== Number(target))
      await sales.edit(context, orderId, {
        commandId: randomUUID(),
        version: record.version,
        lines: [{ id: line.id, currentQuantity: target }],
      });

    return true;
  }

  return {
    async pass() {
      const context = await operator();
      let changed = 0;
      let waiting = 0;
      for (const incident of await incidents()) {
        if (done.has(incident.id)) continue;
        if (await apply(context, incident)) {
          done.add(incident.id);
          changed++;
        } else waiting++;
      }

      return { changed, waiting };
    },
  };
}
