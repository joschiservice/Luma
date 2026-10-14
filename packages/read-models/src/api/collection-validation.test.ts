import {
  collectionField,
  customerQuerySchema,
  customersCatalog,
  customerSortSchema,
  fulfillmentCatalog,
  fulfillmentQuerySchema,
  fulfillmentSortSchema,
  returnQuerySchema,
  returnsCatalog,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { customerStates } from '../application/customers.js';
import {
  fulfillmentDeliveryStates,
  fulfillmentMethodTypes,
  fulfillmentShippingStages,
  fulfillmentSignals,
  fulfillmentStatuses,
} from '../application/fulfillment.js';
import { returnLifecycle, returnRefundStates } from '../application/returns.js';
import { validateCollectionQuery } from './collection-validation.js';

const where = (conditions: unknown[]) =>
  JSON.stringify({ match: 'all', conditions });

describe('configurable list catalogs', () => {
  it('group and show options in the order the read models use', () => {
    const options = (
      catalog: Parameters<typeof collectionField>[0],
      id: string,
    ) => collectionField(catalog, id)?.options;
    expect(options(fulfillmentCatalog, 'status')).toEqual(fulfillmentStatuses);
    expect(options(fulfillmentCatalog, 'signals')).toEqual(fulfillmentSignals);
    expect(options(fulfillmentCatalog, 'stage')).toEqual(
      fulfillmentShippingStages,
    );
    expect(options(fulfillmentCatalog, 'delivery')).toEqual(
      fulfillmentDeliveryStates,
    );
    expect(options(fulfillmentCatalog, 'methodType')).toEqual(
      fulfillmentMethodTypes,
    );
    expect(options(returnsCatalog, 'stage')).toEqual(returnLifecycle);
    expect(options(returnsCatalog, 'refundState')).toEqual(returnRefundStates);
    expect(options(customersCatalog, 'state')).toEqual(customerStates);
  });

  it('marks only fields the list API can sort by', () => {
    const sortable = (catalog: typeof fulfillmentCatalog) =>
      catalog.fields.filter((field) => field.sort).map((field) => field.id);
    for (const id of sortable(fulfillmentCatalog))
      expect(fulfillmentSortSchema.options).toContain(id);
    for (const id of sortable(returnsCatalog))
      expect(returnQuerySchema.shape.sort.unwrap().options).toContain(id);
    // The catalog's `spent` is the API's `amountSpent`.
    for (const id of sortable(customersCatalog))
      expect(customerSortSchema.options).toContain(
        id === 'spent' ? 'amountSpent' : id,
      );
  });
});

describe('configurable list queries', () => {
  it('accepts catalog conditions and groupings', () => {
    expect(() =>
      validateCollectionQuery(
        fulfillmentCatalog,
        fulfillmentQuerySchema.parse({
          where: where([
            { field: 'stage', op: 'any_of', value: ['carrier'] },
            { field: 'holds', op: 'unknown' },
          ]),
          group: 'fulfillBy:week',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateCollectionQuery(
        customersCatalog,
        customerQuerySchema.parse({
          where: where([
            { field: 'country', op: 'any_of', value: ['DE'] },
            {
              field: 'spent',
              op: 'between',
              value: {
                from: { amount: '10', currency: 'EUR' },
                to: null,
              },
            },
          ]),
          group: 'tags',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects conditions and groupings the catalog does not offer with 400', () => {
    for (const [catalog, query] of [
      [
        returnsCatalog,
        returnQuerySchema.parse({
          where: where([{ field: 'name', op: 'contains', value: 'R1' }]),
        }),
      ],
      [
        returnsCatalog,
        returnQuerySchema.parse({
          where: where([{ field: 'value', op: 'gt', value: 40 }]),
        }),
      ],
      [
        returnsCatalog,
        returnQuerySchema.parse({
          where: where([{ field: 'stage', op: 'any_of', value: ['lost'] }]),
        }),
      ],
      [fulfillmentCatalog, fulfillmentQuerySchema.parse({ group: 'units' })],
      [
        fulfillmentCatalog,
        fulfillmentQuerySchema.parse({ group: 'orderPlaced' }),
      ],
      [customersCatalog, customerQuerySchema.parse({ group: 'state:week' })],
      [customersCatalog, customerQuerySchema.parse({ groupKey: '"enabled"' })],
    ] as const)
      expect(() => validateCollectionQuery(catalog, query)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
  });

  it('leaves custom-field conditions to the read model and names the failing condition by position', () => {
    const custom = {
      field: 'custom:6f1c2a52-1b5e-4d4e-9a54-1d8f6a8c3b11',
      op: 'is',
      value: 'wholesale',
    };
    const query = (conditions: unknown[]) =>
      customerQuerySchema.parse({ where: where(conditions) });
    expect(() =>
      validateCollectionQuery(customersCatalog, query([custom]), {
        customFields: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateCollectionQuery(
        customersCatalog,
        query([custom, { field: 'email', op: 'contains', value: 'a' }]),
        { customFields: true },
      ),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: expect.stringMatching(/^Condition 2: /),
      }),
    );
    // Without the option, the catalog alone cannot vouch for a custom field.
    expect(() =>
      validateCollectionQuery(customersCatalog, query([custom])),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
