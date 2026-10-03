import { createApp } from './app.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Simulator is for local development');
const databaseUrl = process.env.LUMA_SIMULATOR_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'LUMA_SIMULATOR_DATABASE_URL is required; pnpm simulator:service provisions it',
  );
const port = Number(process.env.LUMA_SIMULATOR_PORT ?? 5890);
const app = await createApp({
  databaseUrl,
  token: process.env.LUMA_SIMULATOR_TOKEN ?? 'local-synthetic-simulator-token',
});
try {
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  await app.close();
  throw error;
}
console.log(`SIMULATED COMMERCE · http://127.0.0.1:${port}`);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void app.close());
