import { createApp } from './app.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Simulator is for local development');
const app = await createApp(
  process.env.LUMA_SIMULATOR_STORE ?? '.luma/simulator/runs.sqlite',
  process.env.LUMA_SIMULATOR_TOKEN ?? 'local-synthetic-simulator-token',
);
try {
  await app.listen({
    host: '127.0.0.1',
    port: Number(process.env.LUMA_SIMULATOR_PORT ?? 5890),
  });
} catch (error) {
  await app.close();
  throw error;
}
console.log('SIMULATED COMMERCE · http://127.0.0.1:5890');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void app.close());
