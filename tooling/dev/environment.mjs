import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { root, run } from './process.mjs';

export const stateDirectory = join(root, '.luma');

const statePath = join(stateDirectory, 'state.json');

const connectionKeyPath = join(stateDirectory, 'connection-key');

/**
 * Loads or creates the worktree's encryption key; rejects malformed existing keys instead of
 * replacing them.
 */
export async function connectionKey(path = connectionKeyPath) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(32).toString('base64'), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const key = await readFile(path, 'utf8');
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, 'base64').toString('base64') !== key
  )
    throw new Error(
      'Local connection key is invalid. Restore .luma/connection-key from backup.',
    );

  return key;
}

export const project = `luma-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;

/**
 * Returns a currently available loopback port; the port is released before returning and is
 * not reserved.
 */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return port;
}

/**
 * Loads this worktree's local state, creating it only when requested; rejects state from
 * another checkout.
 */
export async function state(create = false) {
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (saved.project !== project)
      throw new Error(
        'Local state belongs to a different checkout. Remove this checkout’s .luma directory and rerun pnpm run setup.',
      );

    return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create)
      throw new Error(
        'No local environment exists. Run mise run setup first.',
        { cause: error },
      );
  }
  const webPort = await freePort();
  let apiPort = await freePort();
  while (apiPort === webPort) apiPort = await freePort();
  const saved = {
    project,
    databasePassword: randomBytes(24).toString('hex'),
    apiPassword: randomBytes(24).toString('hex'),
    workerPassword: randomBytes(24).toString('hex'),
    authSecret: randomBytes(32).toString('hex'),
    webPort,
    apiPort,
    seedPassword: randomBytes(18).toString('hex'),
  };
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(saved, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });

  return saved;
}

/**
 * Runs Docker Compose for this worktree with its saved database credentials and optional
 * captured output.
 */
export function compose(saved, args, capture = false) {
  return run(
    'docker',
    ['compose', '--project-name', project, '--file', 'compose.yaml', ...args],
    {
      env: { ...process.env, LUMA_DB_PASSWORD: saved.databasePassword },
      capture,
    },
  );
}

/**
 * Builds process settings from worktree state and published service ports, including
 * optional Temporal access.
 */
export async function environment(saved, workflows = false) {
  const binding = await compose(saved, ['port', 'postgres', '5432'], true);
  const dbPort = Number(binding.split(':').at(-1));
  if (!dbPort)
    throw new Error('PostgreSQL has no published port. Run pnpm run setup.');
  const database = (user, password) =>
    `postgresql://${user}:${password}@127.0.0.1:${dbPort}/luma`;
  let apiEnv = {};
  try {
    apiEnv = parseEnv(await readFile(join(root, 'apps/api/.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const localOrigin = `http://127.0.0.1:${saved.webPort}`;
  const webOrigin =
    apiEnv.SHOPIFY_WEB_ORIGIN || apiEnv.BETTER_AUTH_URL || localOrigin;
  if (
    new URL(webOrigin).origin !== webOrigin ||
    !['http:', 'https:'].includes(new URL(webOrigin).protocol)
  )
    throw new Error('The configured web URL must be an exact HTTP origin');
  const generated = {
    CONNECTIONS_ACTIVE_KEY_ID: 'local',
    CONNECTIONS_KEYS: JSON.stringify({ local: await connectionKey() }),
    HOST: '127.0.0.1',
    PORT: String(saved.apiPort),
    WEB_PORT: String(saved.webPort),
    API_PROXY_TARGET: `http://127.0.0.1:${saved.apiPort}`,
    IDENTITY_DATABASE_URL: database('luma_api', saved.apiPassword),
    WORKFLOW_DATABASE_URL: database('luma_worker', saved.workerPassword),
    BETTER_AUTH_SECRET: saved.authSecret,
    BETTER_AUTH_COOKIE_PREFIX: project,
    BETTER_AUTH_URL: webOrigin,
    AUTH_TRUSTED_ORIGINS: [...new Set([webOrigin, localOrigin])].join(','),
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(webOrigin).hostname,
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'luma-exceptions-v1',
    TEMPORAL_DATA_REGION: 'EU',
    TEMPORAL_TLS: 'false',
    TEMPORAL_API_KEY: '',
  };
  if (workflows) {
    generated.TEMPORAL_ADDRESS = await compose(
      saved,
      ['port', 'temporal', '7233'],
      true,
    );
  }

  return {
    generated,
    migrationUrl: database('postgres', saved.databasePassword),
    env: { ...process.env, ...generated },
    webOrigin,
  };
}

/**
 * Writes generated settings to the worktree's private environment file with owner-only
 * permissions.
 */
export async function saveEnvironment(generated) {
  await writeFile(
    join(stateDirectory, 'env'),
    Object.entries(generated)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
