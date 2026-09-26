export interface ConnectionsConfig {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

/** Encryption keys and approved destinations are server configuration, never request input. */
export function readConnectionsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConnectionsConfig | undefined {
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

  return { activeKeyId, keys };
}
