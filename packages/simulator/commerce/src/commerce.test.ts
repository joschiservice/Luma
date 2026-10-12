import { createRandom } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { generateCatalog } from './catalog.js';
import { businessCustomer, customer } from './customers.js';
import {
  createAssortment,
  createWholesaleBasket,
  localTime,
  orderRate,
  promotionMultiplier,
  wholesaleRate,
} from './demand.js';
import {
  merchantProfile,
  type MerchantProfileName,
  merchantProfiles,
} from './profiles.js';

const day = 86_400_000;

describe('catalog generation', () => {
  it('is a pure function of profile and seed with a long-tail demand', () => {
    const profile = merchantProfile('mid-market');
    const catalog = generateCatalog(profile, 44);
    expect(generateCatalog(profile, 44)).toEqual(catalog);
    expect(generateCatalog(profile, 45).variants[0]).not.toEqual(
      catalog.variants[0],
    );
    expect(catalog.variants.length).toBeGreaterThan(4_000);
    expect(new Set(catalog.variants.map((variant) => variant.sku)).size).toBe(
      catalog.variants.length,
    );
    const popularity = catalog.variants
      .map((variant) => variant.popularity)
      .sort((a, b) => b - a);
    expect(popularity.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    // The top 10% of SKUs carry most of the demand.
    const top = popularity
      .slice(0, Math.ceil(popularity.length / 10))
      .reduce((sum, value) => sum + value, 0);
    expect(top).toBeGreaterThan(0.5);
    for (const variant of catalog.variants) {
      expect(variant.shops.length).toBeGreaterThan(0);
      expect(Object.keys(variant.stock).sort()).toEqual(['1', '2']);
    }
    expect(
      catalog.suppliers.slice(0, 2).map((supplier) => supplier.profile),
    ).toEqual(['full', 'full']);
  });

  it('keeps the test profile’s fixed products and supplier names', () => {
    const catalog = generateCatalog(merchantProfile('test'), 1);
    expect(
      catalog.variants.map((variant) => [
        variant.id,
        variant.sku,
        variant.stock,
      ]),
    ).toEqual([
      ['1', 'LUMA-001', { 1: 100 }],
      ['2', 'LUMA-SCENARIO-001', { 1: 100 }],
    ]);
    expect(catalog.suppliers.map((supplier) => supplier.name)).toEqual([
      'Nordwind Textil GmbH',
      'Baltic Packaging AB',
    ]);
  });
});

describe('demand', () => {
  it('follows each shop’s local day, week and promotions', () => {
    const profile = merchantProfile('large');
    const shop = profile.shops[0]!;
    const start = Date.parse('2026-10-05T00:00:00Z');
    const rates = Array.from({ length: 24 }, (_, hour) =>
      orderRate(profile, shop, start - 10 * day, start + hour * 3_600_000),
    );
    const daily = rates.reduce((sum, rate) => sum + rate * 3_600_000, 0);
    expect(daily).toBeGreaterThan(5_000 * shop.orderShare * 0.85);
    expect(daily).toBeLessThan(5_000 * shop.orderShare * 1.15);
    expect(Math.max(...rates)).toBeGreaterThan(Math.min(...rates) * 5);
    expect(
      localTime(Date.parse('2026-10-05T12:00:00Z'), 'Europe/Berlin'),
    ).toEqual({ hour: 14, weekday: 1 });
    expect(promotionMultiplier(profile, start, start + 31 * 3_600_000)).toBe(
      10,
    );
    expect(promotionMultiplier(profile, start, start + 40 * 3_600_000)).toBe(1);
    expect(
      orderRate(
        merchantProfile('test'),
        merchantProfile('test').shops[0]!,
        start,
        start,
      ),
    ).toBe(0);
  });

  it('draws baskets from the shop’s listed variants', () => {
    const profile = merchantProfile('large');
    const catalog = generateCatalog(profile, 7);
    const shop = profile.shops[2]!;
    const basket = createAssortment(profile, catalog, shop);
    const random = createRandom(1);
    for (let index = 0; index < 200; index++)
      for (const line of basket(random)) {
        expect(line.variant.shops).toContain(shop.instance);
        expect(line.quantity).toBeGreaterThan(0);
      }
  });

  it('derives the same synthetic customer for the same number', () => {
    expect(customer(1, 'shopify-de', 'DE', 5)).toEqual(
      customer(1, 'shopify-de', 'DE', 5),
    );
    expect(customer(1, 'shopify-de', 'DE', 5).email).toMatch(
      /@customer\.example$/,
    );
  });
});

describe('regional profiles', () => {
  it('only reference warehouses, carriers and currencies the profile defines', () => {
    for (const name of Object.keys(merchantProfiles) as MerchantProfileName[]) {
      const profile = merchantProfile(name);
      const warehouses = new Set(profile.warehouses.map((item) => item.id));
      for (const shop of profile.shops) {
        expect(warehouses, `${name} ${shop.instance}`).toContain(
          shop.warehouse,
        );
        expect(
          shop.currency === profile.currency.base ||
            Object.hasOwn(profile.currency.rates, shop.currency),
          `${name} converts ${shop.currency}`,
        ).toBe(true);
        expect(() => localTime(0, shop.timeZone)).not.toThrow();
      }
      for (const warehouse of profile.warehouses) {
        expect(() => localTime(0, warehouse.timeZone)).not.toThrow();
        expect(
          profile.carriers.some(
            (carrier) =>
              !carrier.warehouses || carrier.warehouses.includes(warehouse.id),
          ),
          `${name} ships from ${warehouse.id}`,
        ).toBe(true);
      }
      if (profile.wholesale)
        expect(warehouses).toContain(profile.wholesale.warehouse);
      expect(profile.company.mailbox.address).toMatch(/\.example$/);
    }
  });

  it('names suppliers from the profile’s directory', () => {
    const profile = merchantProfile('anz-lifestyle');
    const catalog = generateCatalog(profile, 44);
    expect(catalog.suppliers.map((supplier) => supplier.country)).toEqual(
      profile.suppliers.directory?.map((entry) => entry.country),
    );
    expect(catalog.variants.length).toBeGreaterThan(2_000);
  });

  it('derives customers and wholesale accounts that fit the country', () => {
    const person = customer(1, 'shopify-au', 'AU', 5);
    expect(person.phone).toMatch(/^\+61 /);
    expect(person.address.city).toMatch(/ (NSW|VIC|QLD|WA|SA|TAS)$/);
    expect(person.address.address1).toMatch(/^\d+ /);
    expect(customer(1, 'shopify-de', 'DE', 5).phone).toMatch(/^\+49 151 /);
    const account = businessCustomer(1, 'AU', 3);
    expect(account).toEqual(businessCustomer(1, 'AU', 3));
    expect(account.company).toMatch(/ Pty Ltd$/);
    expect(account.email).toBe('orders.3@retailer.example');
  });

  it('takes wholesale orders on weekdays during business hours', () => {
    const profile = merchantProfile('anz-lifestyle');
    // Monday 10:00 and 20:00 and Saturday 10:00 in Sydney.
    const monday = Date.parse('2026-10-04T23:00:00Z');
    expect(wholesaleRate(profile, monday)).toBeGreaterThan(0);
    expect(wholesaleRate(profile, monday + 10 * 3_600_000)).toBe(0);
    expect(wholesaleRate(profile, monday + 5 * day)).toBe(0);
    expect(wholesaleRate(merchantProfile('large'), monday)).toBe(0);
    const basket = createWholesaleBasket(profile, generateCatalog(profile, 1));
    const lines = basket(createRandom(2));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.quantity).toBeGreaterThanOrEqual(4);
      expect(line.quantity).toBeLessThanOrEqual(24);
    }
  });
});
