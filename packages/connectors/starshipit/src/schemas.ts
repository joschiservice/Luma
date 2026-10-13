import { z } from 'zod';

const id = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  ])
  .transform(String);
const text = z
  .string()
  .max(512)
  .nullish()
  .transform((v) => v || null);

/** Offset-free provider dates have unknown timezone and are kept unknown. */
const timestamp = z
  .string()
  .nullish()
  .transform((v) =>
    v && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
      ? new Date(v).toISOString()
      : null,
  );

const decimal = z
  .union([z.number().finite(), z.string()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,14}(\.\d{1,6})?$/))
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    const trimmed = fraction.replace(/0+$/, '');

    return `${whole!.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
  });

const item = z.looseObject({
  item_id: id,
  sku: text,
  description: text,
  quantity: decimal,
  quantity_to_ship: decimal.optional(),
  weight: decimal.nullish(),
  value: decimal.nullish(),
});

export const order = z.looseObject({
  order_id: id,
  order_number: text,
  order_date: timestamp,
  status: text,
  order_status: text,
  carrier_name: text,
  shipping_method: text,
  items: z.array(item).max(500),
  packages: z
    .array(z.looseObject({ package_id: id }))
    .max(100)
    .optional(),
});

export const detail = z.object({ order });

export const list = z.object({
  page_number: z.number().int().positive(),
  total_pages: z.number().int().nonnegative(),
  total_records: z.number().int().nonnegative(),
  data: z.object({ orders: z.array(z.looseObject({ order_id: id })).max(500) }),
});

export const tracking = z.object({
  order_number: text,
  order_status: text,
  carrier_name: text,
  tracking_number: text,
  tracking_url: text,
  shipment_date: timestamp,
  last_updated_date: timestamp,
  tracking_status: text,
  tracking_events: z
    .array(z.object({ event_datetime: timestamp, status: text, details: text }))
    .max(1000)
    .default([]),
});

export const tracked = z
  .object({ results: z.union([tracking, z.array(tracking).max(100)]) })
  .transform((v) => (Array.isArray(v.results) ? v.results : [v.results]));
