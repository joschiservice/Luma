/** Deterministic cloud keys, deliberately distinct from local integer identities. */
export const cloudId = (value: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;

export function cloudPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloudPayload);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        /^(id|itemId|salesOrderId|deliveryNoteId|salesOrderLineItemId)$/.test(
          key,
        ) && typeof field === 'number'
          ? field === 0
            ? null
            : cloudId(field)
          : cloudPayload(field),
      ]),
    );

  return value;
}
