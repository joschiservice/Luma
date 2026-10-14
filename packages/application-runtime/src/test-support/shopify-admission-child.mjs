import { createSharedReadBudget } from '@luma/connector-shopify';
import { createValkeyStore } from '@luma/platform/composition';

const store = createValkeyStore(process.env.SHOPIFY_ADMISSION_URL);
process.once('message', async ({ key, purpose, hold, leaseMs }) => {
  const budget = createSharedReadBudget({
    store,
    key,
    purpose,
    leaseMs,
    maxWaitMs: 0,
  });
  try {
    const result = await budget.run('work', async (feedback) => {
      await feedback.beforeSend?.();
      feedback.dispatched?.();
      process.send({ state: 'admitted' });
      if (hold)
        await new Promise((resolve) => process.once('message', resolve));
      feedback.observe('work', 1000, 1000, 100, 1, 2000);

      return true;
    });
    process.send({ state: 'completed', result });
  } catch (error) {
    process.send({
      state: 'deferred',
      code: error.failure?.code,
      providerCode: error.failure?.providerCode,
    });
  } finally {
    await store.close();
    process.disconnect();
  }
});
process.send({ state: 'ready' });
