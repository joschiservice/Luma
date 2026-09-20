import { isIP } from 'node:net';

import type { ShopifyConfig } from './shopify.js';
import { readShopifyConfig } from './shopify.js';

export interface JtlEndpoint {
  tenantId: string;
  baseUrl: string;
  addresses: string[];
}

export interface ConnectionsConfig {
  shopify?: ShopifyConfig;
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  jtlEndpoints: JtlEndpoint[];
}

/** Encryption keys and approved destinations are server configuration, never request input. */
export function readConnectionsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConnectionsConfig | undefined {
  const shopify = readShopifyConfig(env);
  if (shopify && !env.CONNECTIONS_KEYS)
    throw new Error('Shopify requires connection encryption keys');
  if (!env.CONNECTIONS_KEYS && !env.CONNECTIONS_ACTIVE_KEY_ID) return undefined;
  const invalid = () =>
    new Error(
      'Configure CONNECTIONS_ACTIVE_KEY_ID and CONNECTIONS_KEYS with named 32-byte base64 keys',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(env.CONNECTIONS_KEYS ?? '');
  } catch {
    throw invalid();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const keys = new Map<string, Uint8Array>();
  for (const [id, value] of Object.entries(raw)) {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      typeof value !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value)
    )
      throw invalid();
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) throw invalid();
    keys.set(id, key);
  }
  const activeKeyId = env.CONNECTIONS_ACTIVE_KEY_ID ?? '';
  if (!keys.has(activeKeyId)) throw invalid();
  let endpoints: unknown;
  const invalidEndpoints = () =>
    new Error(
      'JTL_ALLOWED_ENDPOINTS must contain tenantId, an exact HTTPS baseUrl and approved IP addresses',
    );
  try {
    endpoints = JSON.parse(env.JTL_ALLOWED_ENDPOINTS ?? '[]');
  } catch {
    throw invalidEndpoints();
  }
  if (!Array.isArray(endpoints)) throw invalidEndpoints();
  const jtlEndpoints: JtlEndpoint[] = [];
  for (const entry of endpoints) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.baseUrl !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        entry.tenantId ?? '',
      ) ||
      !Array.isArray(entry.addresses) ||
      !entry.addresses.length ||
      !entry.addresses.every(
        (ip: unknown) => typeof ip === 'string' && isIP(ip),
      )
    )
      throw invalidEndpoints();
    let url: URL;
    try {
      url = new URL(entry.baseUrl);
    } catch {
      throw invalidEndpoints();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/') ||
      url.href !== entry.baseUrl ||
      isIP(url.hostname.replace(/^\[|\]$/g, ''))
    )
      throw invalidEndpoints();
    if (
      jtlEndpoints.some(
        (e) => e.tenantId === entry.tenantId && e.baseUrl === entry.baseUrl,
      )
    )
      throw invalidEndpoints();
    jtlEndpoints.push({
      tenantId: entry.tenantId,
      baseUrl: url.href,
      addresses: [...entry.addresses],
    });
  }

  return { activeKeyId, keys, jtlEndpoints, ...(shopify ? { shopify } : {}) };
}
