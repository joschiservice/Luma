/** A seeded source of uniform numbers in [0, 1). */
export interface Random {
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
}

/** Hashes stable parts to an unsigned 32-bit integer with FNV-1a and a final avalanche. */
export function hash32(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = `${part}\u001f`;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  return hash >>> 0;
}

/**
 * Returns a uniform value in [0, 1) derived only from its parts. The same seed and identity
 * always produce the same decision, independently of the order in which callers ask.
 */
export function unit(...parts: readonly (string | number)[]): number {
  return hash32(...parts) / 4294967296;
}

/** Creates a sequential mulberry32 generator for deterministic data generation. */
export function createRandom(seed: number | string): Random {
  let state = typeof seed === 'number' ? seed >>> 0 : hash32(seed);

  return fromNext(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  });
}

/** Creates a generator whose draws depend only on the given parts and the draw number. */
export function keyedRandom(...parts: readonly (string | number)[]): Random {
  let draw = 0;

  return fromNext(() => unit(...parts, draw++));
}

function fromNext(next: () => number): Random {
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick: (values) => {
      if (!values.length) throw new Error('Cannot pick from an empty list');

      return values[Math.floor(next() * values.length)]!;
    },
  };
}

/** Draws a Poisson count with the given mean; large means use a normal approximation. */
export function poisson(random: Random, mean: number): number {
  if (!(mean > 0)) return 0;
  if (mean > 50)
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(random)));
  const limit = Math.exp(-mean);
  let count = 0;
  let product = random.next();
  while (product > limit) {
    count++;
    product *= random.next();
  }

  return count;
}

/** Draws a standard normal value with the Box-Muller transform. */
export function normal(random: Random): number {
  const first = Math.max(random.next(), Number.EPSILON);

  return (
    Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random.next())
  );
}

/**
 * Draws a log-normal duration from its median and 99th percentile. Operational delays are
 * right-skewed: most are near the median and a few take much longer.
 */
export function logNormal(random: Random, median: number, p99: number) {
  if (!(median > 0)) return 0;
  const sigma = Math.max(Math.log(Math.max(p99, median) / median) / 2.326, 0);

  return median * Math.exp(sigma * normal(random));
}

/** Precomputes a cumulative distribution so weighted picks take logarithmic time. */
export function createWeightedPicker<T>(
  values: readonly T[],
  weights: readonly number[],
) {
  if (!values.length || values.length !== weights.length)
    throw new Error('Weighted values need one weight each');
  const cumulative: number[] = [];
  let total = 0;
  for (const weight of weights) {
    total += Math.max(weight, 0);
    cumulative.push(total);
  }
  if (!(total > 0)) throw new Error('Weights must have a positive total');

  return (random: Random): T => {
    const target = random.next() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cumulative[middle]! > target) high = middle;
      else low = middle + 1;
    }

    return values[low]!;
  };
}

/** Zipf-like popularity weights: a few items sell often and a long tail rarely. */
export function zipfWeights(count: number, exponent = 1.07) {
  return Array.from(
    { length: count },
    (_, index) => 1 / (index + 1) ** exponent,
  );
}
