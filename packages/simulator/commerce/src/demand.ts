import {
  createWeightedPicker,
  logNormal,
  type Random,
} from '@luma/simulator-core';

import type { Catalog, CatalogVariant } from './catalog.js';
import type { MerchantProfile, ShopProfile } from './profiles.js';

const dayMs = 86_400_000;
const hourMs = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Returns the local hour and weekday (Sunday is 0) in a shop's time zone. */
export function localTime(time: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(time);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((part) => part.type === 'weekday')?.value ?? 'Sun',
  );

  return { hour, weekday: Math.max(weekday, 0) };
}

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

/** Returns the demand multiplier of promotions active at `time`. */
export function promotionMultiplier(
  profile: MerchantProfile,
  runStart: number,
  time: number,
) {
  let multiplier = 1;
  for (const promotion of profile.demand.promotions) {
    const start = runStart + promotion.startsAfterHours * hourMs;
    if (time < start) continue;
    const elapsed = time - start;
    const offset = promotion.everyDays
      ? elapsed % (promotion.everyDays * dayMs)
      : elapsed;
    if (offset < promotion.durationHours * hourMs)
      multiplier = Math.max(multiplier, promotion.multiplier);
  }

  return multiplier;
}

/** Expected orders per millisecond for one shop, following its local day and week. */
export function orderRate(
  profile: MerchantProfile,
  shop: ShopProfile,
  runStart: number,
  time: number,
) {
  if (!profile.demand.autonomous || !profile.demand.ordersPerDay) return 0;
  const { hour, weekday } = localTime(time, shop.timeZone);
  const daily = profile.demand.hourly[hour]! / mean(profile.demand.hourly);
  const weekly = profile.demand.weekly[weekday]! / mean(profile.demand.weekly);

  return (
    ((profile.demand.ordersPerDay * shop.orderShare) / dayMs) *
    daily *
    weekly *
    promotionMultiplier(profile, runStart, time)
  );
}

/** Picks basket lines from the variants a shop lists, weighted by popularity. */
export function createAssortment(
  profile: MerchantProfile,
  catalog: Catalog,
  shop: ShopProfile,
) {
  const listed = catalog.variants.filter((variant) =>
    variant.shops.includes(shop.instance),
  );
  if (!listed.length) throw new Error(`${shop.instance} lists no products`);
  const pickVariant = createWeightedPicker(
    listed,
    listed.map((variant) => variant.popularity),
  );
  const lineCounts = profile.basket.lineWeights.map((_, index) => index + 1);
  const pickLines = createWeightedPicker(
    lineCounts,
    profile.basket.lineWeights,
  );
  const pickQuantity = createWeightedPicker(
    profile.basket.quantityWeights.map((_, index) => index + 1),
    profile.basket.quantityWeights,
  );

  return (random: Random) => {
    const lines = new Map<
      string,
      { variant: CatalogVariant; quantity: number }
    >();
    const count = Math.min(pickLines(random), listed.length);
    for (
      let attempt = 0;
      lines.size < count && attempt < count * 4;
      attempt++
    ) {
      const variant = pickVariant(random);
      if (!lines.has(variant.id))
        lines.set(variant.id, { variant, quantity: pickQuantity(random) });
    }

    return [...lines.values()];
  };
}

/** Draws a duration in milliseconds from a profile given in days. */
export const days = (
  random: Random,
  profile: { medianMs: number; p99Ms: number },
) => logNormal(random, profile.medianMs, profile.p99Ms) * dayMs;
