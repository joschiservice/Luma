import type { InventorySnapshot, Observation } from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import { type createClient, parse } from '@luma/connector-shopify';
import { z } from 'zod';

const receiptSchema = z.object({
  evidenceId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }),
  inventoryItemId: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/),
  locationId: z.string().regex(/^gid:\/\/shopify\/Location\/[0-9]+$/),
  adjustmentId: z
    .string()
    .regex(/^gid:\/\/shopify\/InventoryAdjustmentGroup\/[0-9]+$/),
  referenceDocumentUri: z.string().min(1).max(1024),
  idempotencyKey: z.string().min(1).max(512),
  expectedAvailable: z.number().int(),
  available: z.number().int(),
});

/** A tenant-scoped accepted correction receipt; it establishes an action, not current stock. */
export type InventoryWriteReceipt = z.infer<typeof receiptSchema>;

/** Reads at most twenty exact accepted adjustments in one request. Invalid or unavailable proof returns no attribution. */
export async function readInventoryWriteProofs(
  request: ReturnType<typeof createClient>,
  receipts: InventoryWriteReceipt[],
): Promise<InventoryWriteReceipt[]> {
  const candidates: InventoryWriteReceipt[] = [];
  for (const input of receipts.slice(0, 20)) {
    const parsed = receiptSchema.safeParse(input);
    if (!parsed.success) continue;
    const receipt = parsed.data;
    if (
      receipt.referenceDocumentUri !==
      `luma://inventory-corrections/${receipt.idempotencyKey}`
    )
      continue;
    candidates.push(receipt);
  }
  if (!candidates.length) return [];
  const variables: Record<string, unknown> = {};
  const declarations: string[] = [];
  const selections = candidates.map((receipt, index) => {
    declarations.push(
      `$id${index}: ID!, $item${index}: [ID!], $location${index}: [ID!]`,
    );
    variables[`id${index}`] = receipt.adjustmentId;
    variables[`item${index}`] = [receipt.inventoryItemId];
    variables[`location${index}`] = [receipt.locationId];

    return `proof${index}: node(id: $id${index}) { ... on InventoryAdjustmentGroup {
      id reason referenceDocumentUri
      changes(inventoryItemIds: $item${index}, locationIds: $location${index}, quantityNames: ["available"]) {
        name delta quantityAfterChange
      }
    } }`;
  });
  try {
    const raw = await request(
      `query LumaInventoryWriteProof(${declarations.join(', ')}) { ${selections.join('\n')} }`,
      variables,
    );

    return candidates.filter((receipt, index) => {
      const group = parse(
        z
          .object({
            id: z.string(),
            reason: z.string(),
            referenceDocumentUri: z.string().nullable(),
            changes: z.array(
              z.object({
                name: z.string(),
                delta: z.number().int(),
                quantityAfterChange: z.number().int().nullable(),
              }),
            ),
          })
          .nullable(),
        raw[`proof${index}`],
      );
      const change = group?.changes[0];

      return (
        !!group &&
        group.id === receipt.adjustmentId &&
        group.reason === 'correction' &&
        group.referenceDocumentUri === receipt.referenceDocumentUri &&
        group.changes.length === 1 &&
        change?.name === 'available' &&
        change.delta === receipt.available - receipt.expectedAvailable &&
        change.quantityAfterChange === receipt.available
      );
    });
  } catch (error) {
    // Failed secondary proof leaves quantity evidence usable and authorship unknown.
    if (!(error instanceof ConnectorError)) throw error;

    return [];
  }
}

/** Adds corroborated adjustment facts to supplied later exact-target observations without changing their quantities. */
export async function attributeInventoryWrites(
  request: ReturnType<typeof createClient>,
  observations: {
    kind: Observation<InventorySnapshot>['kind'];
    observedAt: string;
    data: Pick<InventorySnapshot, 'sku' | 'location' | 'available'> & {
      writeAttribution?: InventorySnapshot['writeAttribution'];
    };
  }[],
  receipts: InventoryWriteReceipt[],
) {
  const relevant = receipts.filter((receipt) =>
    observations.some(
      (observation) =>
        observation.kind === 'snapshot' &&
        observation.data.sku.externalId === receipt.inventoryItemId &&
        observation.data.sku.scopeKey === '' &&
        observation.data.location.externalId === receipt.locationId &&
        observation.data.location.scopeKey === '' &&
        Date.parse(observation.observedAt) >= Date.parse(receipt.observedAt),
    ),
  );
  const proven = await readInventoryWriteProofs(request, relevant);
  for (const receipt of proven) {
    for (const observation of observations) {
      if (
        observation.kind === 'snapshot' &&
        observation.data.sku.externalId === receipt.inventoryItemId &&
        observation.data.sku.scopeKey === '' &&
        observation.data.location.externalId === receipt.locationId &&
        observation.data.location.scopeKey === '' &&
        Date.parse(observation.observedAt) >= Date.parse(receipt.observedAt)
      ) {
        observation.data.writeAttribution = {
          evidenceId: receipt.evidenceId,
          adjustmentId: receipt.adjustmentId,
          referenceDocumentUri: receipt.referenceDocumentUri,
          available: String(receipt.available),
          quantityMatches:
            observation.data.available === null
              ? null
              : Number(observation.data.available) === receipt.available,
        };
      }
    }
  }
}
