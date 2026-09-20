export interface ModelGatewayConfig {
  routes: Record<
    string,
    {
      adapter: 'vercel' | 'bedrock-eu';
      model: string;
      providers: string[];
      zeroDataRetention: boolean;
    }
  >;
  apiKey?: string;
  timeoutMs: number;
}

/** Profiles and provider allowlists are deployment policy, never request parameters. */
export function readModelGatewayConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelGatewayConfig {
  const timeout = env.MODEL_GATEWAY_TIMEOUT_MS ?? '30000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 120000)
    throw new Error('MODEL_GATEWAY_TIMEOUT_MS must be between 1 and 120000');
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
      !['vercel', 'bedrock-eu'].includes(String(route.adapter)) ||
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
      adapter: route.adapter as 'vercel' | 'bedrock-eu',
      model: route.model,
      providers: [...new Set(route.providers as string[])],
      zeroDataRetention: route.zeroDataRetention,
    };
  }
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (
    Object.values(routes).some((route) => route.adapter === 'vercel') &&
    (!apiKey?.trim() || /\s/.test(apiKey))
  )
    throw new Error('AI_GATEWAY_API_KEY is required for Vercel routes');

  return { routes, timeoutMs: Number(timeout), ...(apiKey ? { apiKey } : {}) };
}
