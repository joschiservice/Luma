import type { DataRegion } from './regions.js';
import { readRegionConfig, regionalAwsRegions } from './regions.js';

export interface ModelGatewayConfig {
  dataRegion: DataRegion;
  routes: Record<
    string,
    {
      adapter: 'vercel' | 'bedrock';
      model: string;
      providers: string[];
      zeroDataRetention: boolean;
    }
  >;
  apiKey?: string;
  bedrock?: {
    region: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
  };
  timeoutMs: number;
  /**
   * Input and output tokens each tenant may use per UTC day, across all model features. The
   * reader always sets it; without it, tenants have no daily budget.
   */
  tenantDailyTokens?: number;
}

/**
 * Reads model routes and provider credentials. Profiles and provider allowlists are
 * deployment policy, never request parameters. Throws when a configured route lacks its
 * credentials, when Bedrock settings are partial or outside the cell jurisdiction, or when any value is
 * invalid; error messages never include configured values.
 */
export function readModelGatewayConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelGatewayConfig {
  const { region: dataRegion } = readRegionConfig(env);
  const timeout = env.MODEL_GATEWAY_TIMEOUT_MS ?? '30000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 120000)
    throw new Error('MODEL_GATEWAY_TIMEOUT_MS must be between 1 and 120000');
  const dailyTokens = env.MODEL_TENANT_DAILY_TOKENS ?? '5000000';
  if (
    !/^\d+$/.test(dailyTokens) ||
    Number(dailyTokens) < 1000 ||
    Number(dailyTokens) > 1_000_000_000
  )
    throw new Error(
      'MODEL_TENANT_DAILY_TOKENS must be between 1000 and 1000000000',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(env.MODEL_GATEWAY_ROUTES ?? '{}');
  } catch {
    throw new Error('MODEL_GATEWAY_ROUTES must be a JSON object');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('MODEL_GATEWAY_ROUTES must be a JSON object');
  const routes: ModelGatewayConfig['routes'] = {};
  for (const [profile, value] of Object.entries(raw)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(profile) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw new Error('Invalid model profile');
    const route = value as Record<string, unknown>;
    if (
      Object.keys(route).some(
        (key) =>
          !['adapter', 'model', 'providers', 'zeroDataRetention'].includes(key),
      ) ||
      !['vercel', 'bedrock'].includes(String(route.adapter)) ||
      typeof route.model !== 'string' ||
      !/^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(route.model) ||
      !Array.isArray(route.providers) ||
      !route.providers.length ||
      !route.providers.every(
        (provider: unknown) =>
          typeof provider === 'string' &&
          /^[a-z][a-z0-9-]{0,63}$/.test(provider),
      ) ||
      typeof route.zeroDataRetention !== 'boolean'
    )
      throw new Error('Invalid model route');
    routes[profile] = {
      adapter: route.adapter as 'vercel' | 'bedrock',
      model: route.model,
      providers: [...new Set(route.providers as string[])],
      zeroDataRetention: route.zeroDataRetention,
    };
  }
  if (
    dataRegion === 'AU' &&
    Object.values(routes).some((route) => route.adapter === 'vercel')
  )
    throw new Error('Vercel AI Gateway is unavailable in the AU cell');
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (
    Object.values(routes).some((route) => route.adapter === 'vercel') &&
    (!apiKey?.trim() || /\s/.test(apiKey))
  )
    throw new Error('AI_GATEWAY_API_KEY is required for Vercel routes');
  const bedrock = readBedrockConfig(env);
  if (
    Object.values(routes).some((route) => route.adapter === 'bedrock') &&
    !bedrock
  )
    throw new Error(
      'MODEL_GATEWAY_BEDROCK_REGION, MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID and MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY are required for Bedrock routes',
    );

  return {
    dataRegion,
    routes,
    timeoutMs: Number(timeout),
    tenantDailyTokens: Number(dailyTokens),
    ...(apiKey ? { apiKey } : {}),
    ...(bedrock ? { bedrock } : {}),
  };
}

function readBedrockConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelGatewayConfig['bedrock'] {
  const region = env.MODEL_GATEWAY_BEDROCK_REGION || undefined;
  const accessKeyId = env.MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID || undefined;
  const secretAccessKey =
    env.MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY || undefined;
  const sessionToken = env.MODEL_GATEWAY_BEDROCK_SESSION_TOKEN || undefined;
  if (!region && !accessKeyId && !secretAccessKey && !sessionToken)
    return undefined;
  if (!region || !accessKeyId || !secretAccessKey)
    throw new Error(
      'Configure MODEL_GATEWAY_BEDROCK_REGION, MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID and MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY together',
    );
  if (!regionalAwsRegions[readRegionConfig(env).region].includes(region))
    throw new Error(
      'MODEL_GATEWAY_BEDROCK_REGION must be an AWS region in the cell jurisdiction',
    );
  if (
    !/^[A-Z0-9]{16,128}$/.test(accessKeyId) ||
    /\s/.test(secretAccessKey) ||
    (sessionToken !== undefined && /\s/.test(sessionToken))
  )
    throw new Error('Bedrock credentials are invalid');

  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}
