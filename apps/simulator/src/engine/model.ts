import { type Cin7Config, simulatedAccountId } from '@luma/simulator-cin7';
import {
  type Catalog,
  type CatalogProduct,
  type CatalogVariant,
  createAssortment,
  generateCatalog,
  type MerchantProfile,
  type ShopProfile,
} from '@luma/simulator-commerce';
import type { Random } from '@luma/simulator-core';
import type { JtlConfig } from '@luma/simulator-jtl';
import type { ShopifyConfig } from '@luma/simulator-shopify';

export type Instance =
  | { name: string; kind: 'jtl'; label: string; config: JtlConfig }
  | { name: string; kind: 'cin7'; label: string; config: Cin7Config }
  | {
      name: string;
      kind: 'shopify';
      label: string;
      config: ShopifyConfig;
      shop: ShopProfile;
    };

/** JTL shipping methods: Standard, Express and Pickup, as in the seeded fixtures. */
export const shippingMethods = { standard: '7', express: '8', pickup: '9' };

/** The ERP instance a merchant runs; each run has exactly one. */
export type ErpInstance = Extract<Instance, { kind: 'jtl' | 'cin7' }>;

const shopifyScopes = [
  'read_orders',
  'read_all_orders',
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
  'read_returns',
  'read_customers',
];

// Standard VAT rates of the profiles' shop countries; Shopify reports them per order line.
const standardTaxRates: Record<string, number> = {
  AT: 0.2,
  CH: 0.081,
  DE: 0.19,
};

/** Derives the provider instances a profile runs: one ERP and one store per shop. */
export function instancesFor(profile: MerchantProfile): Instance[] {
  const erp = {
    warehouses: profile.warehouses.map(({ id, name }) => ({ id, name })),
    shippingMethods: [
      { id: shippingMethods.standard, name: 'Standard' },
      { id: shippingMethods.express, name: 'Express' },
      { id: shippingMethods.pickup, name: 'Pickup' },
    ],
  };

  return [
    profile.erp === 'cin7'
      ? {
          name: 'cin7',
          kind: 'cin7',
          label: 'Cin7 Core',
          config: {
            ...erp,
            accountId: simulatedAccountId,
            company: profile.label,
          },
        }
      : { name: 'jtl', kind: 'jtl', label: 'JTL-Wawi', config: erp },
    ...profile.shops.map((shop): Instance => ({
      name: shop.instance,
      kind: 'shopify',
      label: shop.name,
      shop,
      config: {
        shop: shop.domain,
        name: shop.name,
        currency: shop.currency,
        ...(Object.hasOwn(standardTaxRates, shop.country)
          ? { taxRate: standardTaxRates[shop.country] }
          : {}),
        orderPrefix: profile.name === 'test' ? 'SIM-' : shop.country,
        locations: [
          {
            id: shop.warehouse,
            name:
              profile.warehouses.find((w) => w.id === shop.warehouse)?.name ??
              'Warehouse',
          },
        ],
        scopes: shopifyScopes,
      },
    })),
  ];
}

/** Profile-derived lookups that every engine step needs; cached per run. */
export interface WorldModel {
  profile: MerchantProfile;
  catalog: Catalog;
  instances: Instance[];
  /** The merchant's ERP instance. */
  erp: ErpInstance;
  shops: Extract<Instance, { kind: 'shopify' }>[];
  variant(id: string): CatalogVariant;
  product(id: string): CatalogProduct;
  variantBySku(sku: string): CatalogVariant | undefined;
  /** Draws a basket from a shop's assortment. */
  basket(
    shop: string,
    random: Random,
  ): { variant: CatalogVariant; quantity: number }[];
  /** Expected units sold per day for a variant across all shops. */
  dailyUnits(variant: CatalogVariant): number;
}

const cache = new Map<string, { key: string; model: WorldModel }>();

/** Builds or reuses the world model for a run's profile and seed. */
export function worldModel(
  runId: string,
  profile: MerchantProfile,
  seed: number,
): WorldModel {
  const key = `${seed}:${JSON.stringify(profile)}`;
  const cached = cache.get(runId);
  if (cached?.key === key) return cached.model;
  const catalog = generateCatalog(profile, seed);
  const instances = instancesFor(profile);
  const shops = instances.filter(
    (instance): instance is Extract<Instance, { kind: 'shopify' }> =>
      instance.kind === 'shopify',
  );
  const byId = new Map(
    catalog.variants.map((variant) => [variant.id, variant]),
  );
  const products = new Map(
    catalog.products.map((product) => [product.id, product]),
  );
  const bySku = new Map(
    catalog.variants.map((variant) => [variant.sku, variant]),
  );
  const assortments = new Map<string, ReturnType<typeof createAssortment>>();
  const unitsPerDay =
    profile.demand.ordersPerDay *
    (profile.basket.lineWeights.reduce((sum, w, i) => sum + w * (i + 1), 0) /
      profile.basket.lineWeights.reduce((sum, w) => sum + w, 0));
  const erp = instances.find(
    (instance): instance is ErpInstance => instance.kind !== 'shopify',
  );
  if (!erp) throw new Error('A merchant runs one ERP');
  const model: WorldModel = {
    profile,
    catalog,
    instances,
    erp,
    shops,
    variant(id) {
      const variant = byId.get(id);
      if (!variant) throw new Error(`Unknown variant ${id}`);

      return variant;
    },
    product(id) {
      const product = products.get(id);
      if (!product) throw new Error(`Unknown product ${id}`);

      return product;
    },
    variantBySku: (sku) => bySku.get(sku),
    basket(shop, random) {
      let assortment = assortments.get(shop);
      if (!assortment) {
        const instance = shops.find((item) => item.name === shop);
        if (!instance) throw new Error(`Unknown shop ${shop}`);
        assortment = createAssortment(profile, catalog, instance.shop);
        assortments.set(shop, assortment);
      }

      return assortment(random);
    },
    dailyUnits: (variant) => variant.popularity * unitsPerDay,
  };
  cache.set(runId, { key, model });

  return model;
}

/** Drops a run's cached model after reset or deletion. */
export function forgetModel(runId: string) {
  cache.delete(runId);
}
