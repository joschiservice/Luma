import {
  ClosingError,
  ConnectionError,
  GlideClient,
  GlideClusterClient,
  Script,
} from '@valkey/valkey-glide';

import type { AtomicStore } from '../application/atomic-store.js';

/**
 * Whether a command failed because the connection is unusable rather than because of the
 * command itself. Script, reply and per-request timeout errors leave the shared connection,
 * and the other commands in flight on it, intact.
 */
function connectionLost(error: unknown) {
  return error instanceof ClosingError || error instanceof ConnectionError;
}

/**
 * Opens a lazy, primary-only Valkey connection. A lost connection is closed and new commands
 * fail for one second before it is reopened; command errors are rethrown without touching it.
 */
export function createValkeyStore(url: string, cluster = false): AtomicStore {
  const target = new URL(url);
  const scripts = new Map<string, Script>();
  let opening: Promise<GlideClient | GlideClusterClient> | undefined;
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  let unavailableUntil = 0;
  const disconnect = async () => {
    const previous = opening;
    opening = undefined;
    try {
      (await previous)?.close();
    } catch {
      /* Connection establishment failed. */
    }
  };
  const connect = () => {
    if (closed) return Promise.reject(new Error('Request admission is closed'));
    if (performance.now() < unavailableUntil)
      return Promise.reject(new Error('Request admission is unavailable'));
    const configuration = {
      addresses: [{ host: target.hostname, port: Number(target.port || 6379) }],
      useTLS: target.protocol === 'rediss:',
      requestTimeout: 1000,
      advancedConfiguration: { connectionTimeout: 1000 },
      clientName: 'luma-request-admission',
      ...(target.password
        ? {
            credentials: {
              password: decodeURIComponent(target.password),
              ...(target.username
                ? { username: decodeURIComponent(target.username) }
                : {}),
            },
          }
        : {}),
    };
    opening ??= (
      cluster
        ? GlideClusterClient.createClient(configuration)
        : GlideClient.createClient(configuration)
    ).catch((error: unknown) => {
      opening = undefined;
      unavailableUntil = performance.now() + 1000;
      throw error;
    });

    return opening;
  };

  return {
    async run(source, key, arguments_) {
      if (closed) throw new Error('Request admission is closed');
      let script = scripts.get(source);
      if (!script) {
        script = new Script(source);
        scripts.set(source, script);
      }
      const command = connect().then((client) =>
        client.invokeScript(script, { keys: [key], args: [...arguments_] }),
      );
      pending.add(command);
      try {
        return await command;
      } catch (error) {
        if (connectionLost(error)) {
          unavailableUntil = performance.now() + 1000;
          await disconnect();
        }
        throw error;
      } finally {
        pending.delete(command);
      }
    },
    async ready() {
      try {
        return (await (await connect()).ping()) === 'PONG';
      } catch {
        await disconnect();

        return false;
      }
    },
    async close() {
      closed = true;
      await disconnect();
      await Promise.allSettled(pending);
      for (const script of scripts.values()) script.release();
      scripts.clear();
    },
  };
}
