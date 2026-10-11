import {
  createRandom,
  createWeightedPicker,
  type Random,
  zipfWeights,
} from '@luma/simulator-core';

import type { CategoryProfile, MerchantProfile } from './profiles.js';

export interface CatalogVariant {
  /** Shared variant number; providers derive their own record IDs from it. */
  id: string;
  productId: string;
  sku: string;
  title: string;
  /** Catalog gross price in the merchant's base currency. */
  price: number;
  barcode: string | null;
  /** Relative demand; weights across the catalog sum to one. */
  popularity: number;
  /** Starting stock per warehouse ID. */
  stock: Record<string, number>;
  /** Shop instances that list this variant. */
  shops: string[];
  supplierId: string;
  /** Net purchase price from the default supplier. */
  cost: number;
}

export interface CatalogProduct {
  id: string;
  title: string;
  vendor: string;
  category: string;
  /** Unpublished products are listed but not sold online. */
  published: boolean;
  variants: CatalogVariant[];
}

export interface CatalogSupplier {
  id: string;
  name: string;
  number: string;
  city: string;
  country: string;
  email: string;
  profile: 'full' | 'partial' | 'delayed' | 'short' | 'silent';
}

export interface Catalog {
  products: CatalogProduct[];
  variants: CatalogVariant[];
  suppliers: CatalogSupplier[];
}

const adjectives = [
  'Everyday',
  'Coastal',
  'Alpine',
  'Urban',
  'Classic',
  'Relaxed',
  'Heritage',
  'Studio',
  'Field',
  'Harbor',
  'Nordic',
  'Weekend',
  'Utility',
  'Soft',
  'Bold',
];
const materials = [
  'Linen',
  'Merino',
  'Canvas',
  'Cotton',
  'Leather',
  'Wool',
  'Denim',
  'Ceramic',
  'Oak',
  'Recycled',
  'Organic',
  'Waxed',
  'Suede',
  'Jersey',
  'Bamboo',
];
const nouns: Record<string, string[]> = {
  APP: [
    'Shirt',
    'Overshirt',
    'Tee',
    'Sweater',
    'Chino',
    'Jacket',
    'Hoodie',
    'Dress',
  ],
  SHO: ['Sneaker', 'Boot', 'Loafer', 'Sandal', 'Runner'],
  ACC: ['Tote', 'Belt', 'Cap', 'Scarf', 'Wallet', 'Backpack'],
  HOM: ['Throw', 'Mug', 'Vase', 'Cushion', 'Planter', 'Lamp', 'Bowl'],
};
const vendors = [
  'Luma Goods',
  'Nordwind',
  'Fjell & Co',
  'Atelier Rhein',
  'Kontor Basics',
  'Seeufer',
  'Hafenwerk',
];
const supplierNames = [
  'Nordwind Textil GmbH',
  'Baltic Packaging AB',
  'Porto Knitwear Lda',
  'Anatolia Cotton A.Ş.',
  'Lombardia Pelletteria Srl',
  'Vistula Home Sp. z o.o.',
  'Danube Ceramics Kft',
  'Iberia Calzado SL',
  'Brabant Trading BV',
  'Tatra Wool s.r.o.',
];
const supplierCities: [string, string][] = [
  ['Hamburg', 'DE'],
  ['Malmö', 'SE'],
  ['Porto', 'PT'],
  ['Izmir', 'TR'],
  ['Milan', 'IT'],
  ['Kraków', 'PL'],
  ['Pécs', 'HU'],
  ['Elche', 'ES'],
  ['Eindhoven', 'NL'],
  ['Brno', 'CZ'],
];

/** Builds an EAN-13 with a valid check digit. */
function ean(random: Random) {
  const digits = Array.from({ length: 12 }, (_, index) =>
    index === 0 ? 4 : random.int(0, 9),
  );
  const sum = digits.reduce(
    (total, digit, index) => total + digit * (index % 2 ? 3 : 1),
    0,
  );

  return [...digits, (10 - (sum % 10)) % 10].join('');
}

function shuffle<T>(random: Random, values: T[]) {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random.next() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }

  return values;
}

/** Average units ordered per order, from the basket profile. */
function unitsPerOrder(profile: MerchantProfile) {
  const mean = (weights: number[]) => {
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    return weights.reduce(
      (sum, weight, index) => sum + (weight / total) * (index + 1),
      0,
    );
  };

  return (
    mean(profile.basket.lineWeights) * mean(profile.basket.quantityWeights)
  );
}

function suppliersFor(profile: MerchantProfile, random: Random) {
  const pickProfile = createWeightedPicker(
    Object.keys(profile.suppliers.profileMix) as CatalogSupplier['profile'][],
    Object.values(profile.suppliers.profileMix),
  );

  return Array.from(
    { length: Math.max(1, profile.suppliers.count) },
    (_, index): CatalogSupplier => {
      const base = supplierNames[index % supplierNames.length]!;
      const [city, country] = supplierCities[index % supplierCities.length]!;
      const round = Math.floor(index / supplierNames.length);

      return {
        id: String(index + 1),
        name: round ? `${base} ${round + 1}` : base,
        number: `L-${1001 + index}`,
        city,
        country,
        email: `orders${index + 1}@supplier.example`,
        // The first suppliers keep the seeded fixtures' dependable behavior.
        profile: index < 2 ? 'full' : pickProfile(random),
      };
    },
  );
}

function fixedCatalog(profile: MerchantProfile): Catalog {
  const shops = profile.shops.map((shop) => shop.instance);
  const variants: CatalogVariant[] = [];
  const products = (profile.catalog.fixed ?? []).map((product) => ({
    id: product.id,
    title: product.title,
    vendor: product.vendor,
    category: product.category,
    published: product.variants.every((variant) => variant.published !== false),
    variants: product.variants.map((variant) => {
      const value: CatalogVariant = {
        id: variant.id,
        productId: product.id,
        sku: variant.sku,
        title: variant.title,
        price: variant.price,
        barcode: variant.barcode,
        popularity: 0,
        stock: variant.stock,
        shops: variant.shops ?? shops,
        supplierId: '1',
        cost: Math.round(variant.price * 0.4 * 100) / 100,
      };
      variants.push(value);

      return value;
    }),
  }));
  for (const variant of variants) variant.popularity = 1 / variants.length;
  const random = createRandom('fixed-suppliers');

  return { products, variants, suppliers: suppliersFor(profile, random) };
}

/**
 * Generates the merchant's catalog, starting stock and supplier assignments. The result is a
 * pure function of profile and seed; callers seed providers from it.
 */
export function generateCatalog(
  profile: MerchantProfile,
  seed: number,
): Catalog {
  if (profile.catalog.fixed?.length) return fixedCatalog(profile);
  const random = createRandom(`${seed}:catalog`);
  const suppliers = suppliersFor(profile, random);
  const pickCategory = createWeightedPicker(
    profile.catalog.categories,
    profile.catalog.categories.map((category) => category.share),
  );
  const products: CatalogProduct[] = [];
  const variants: CatalogVariant[] = [];
  for (let index = 0; index < profile.catalog.products; index++) {
    const category: CategoryProfile = pickCategory(random);
    const productId = String(index + 1);
    const noun = random.pick(nouns[category.code] ?? ['Item']);
    const title = `${random.pick(adjectives)} ${random.pick(materials)} ${noun}`;
    const [minPrice, maxPrice] = category.priceRange;
    const price =
      Math.round(minPrice + random.next() * (maxPrice - minPrice)) - 0.01;
    const colors = shuffle(random, [...category.colors]);
    const count = random.int(...profile.catalog.variantsPerProduct);
    const options: string[] = [];
    for (const color of colors) {
      for (const size of category.sizes.length ? category.sizes : ['']) {
        options.push(size ? `${color} / ${size}` : color);
        if (options.length >= count) break;
      }
      if (options.length >= count) break;
    }
    const supplier = suppliers[index % suppliers.length]!;
    const product: CatalogProduct = {
      id: productId,
      title,
      vendor: random.pick(vendors),
      category: category.code,
      published: random.next() > 0.03,
      variants: [],
    };
    for (const option of options) {
      const variantNumber = variants.length + 1;
      const variant: CatalogVariant = {
        id: String(variantNumber),
        productId,
        sku: `${category.code}-${productId.padStart(5, '0')}-${option
          .replace(/[^A-Za-z0-9]+/g, '')
          .toUpperCase()
          .slice(0, 8)}`,
        title: options.length === 1 ? 'Default Title' : option,
        price,
        barcode:
          random.next() < profile.catalog.missingBarcodeRate
            ? null
            : ean(random),
        popularity: 0,
        stock: {},
        shops: [],
        supplierId: supplier.id,
        cost: Math.round(price * (0.32 + random.next() * 0.16) * 100) / 100,
      };
      product.variants.push(variant);
      variants.push(variant);
    }
    products.push(product);
  }
  // Popularity follows a long tail over a shuffled order, so bestsellers spread across categories.
  const weights = zipfWeights(
    variants.length,
    profile.catalog.popularityExponent,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const ranking = shuffle(
    random,
    variants.map((_, index) => index),
  );
  ranking.forEach((variantIndex, rank) => {
    variants[variantIndex]!.popularity = weights[rank]! / total;
  });
  const dailyUnits = profile.demand.ordersPerDay * unitsPerOrder(profile);
  for (const product of products) {
    // Smaller shops list a stable subset of products, chosen per product.
    const listed = profile.shops
      .filter((shop) => random.next() < shop.catalogShare)
      .map((shop) => shop.instance);
    for (const variant of product.variants) {
      variant.shops = listed.length ? listed : [profile.shops[0]!.instance];
      const [low, high] = profile.catalog.daysOfCover;
      const cover = low + random.next() * (high - low);
      const units = Math.max(
        2,
        Math.round(variant.popularity * dailyUnits * cover),
      );
      for (const warehouse of profile.warehouses)
        variant.stock[warehouse.id] = Math.round(units * warehouse.stockShare);
    }
  }

  return { products, variants, suppliers };
}
