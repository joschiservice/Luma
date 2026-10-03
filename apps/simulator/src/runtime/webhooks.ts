import { createHmac } from 'node:crypto';

import type { Pool } from 'pg';

/** Shopify retries failed deliveries with growing delays before giving up. */
const retryDelays = [5_000, 30_000, 120_000, 600_000, 1_800_000];

interface Delivery {
  id: string;
  run_id: string;
  instance: string;
  topic: string;
  event_id: string;
  body: unknown;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Delivers queued webhooks like Shopify: original JSON bytes signed with HMAC-SHA256 of the app
 * secret, topic, shop, event and webhook IDs in headers, retries with backoff. Dropped
 * deliveries were already decided when the event was queued.
 */
export function createWebhookDelivery(
  pool: Pool,
  fetchImpl: typeof fetch = fetch,
) {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= pass()
      .catch((error: unknown) =>
        console.error('Simulator webhook delivery failed', error),
      )
      .finally(() => {
        running = undefined;
      });
  }, 500);
  timer.unref();

  async function pass() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Delivery>(
        `SELECT w.id, w.run_id, w.instance, w.topic, w.event_id, w.body, w.attempts, t.url, t.secret
         FROM sim_webhooks w
         JOIN sim_webhook_targets t ON t.run_id = w.run_id AND t.instance = w.instance
         WHERE w.status = 'pending' AND w.due_at <= $1
         ORDER BY w.due_at LIMIT 50 FOR UPDATE OF w SKIP LOCKED`,
        [Date.now()],
      );
      const { rows: shops } = await client.query<{
        run_id: string;
        instance: string;
        domain: string;
      }>(
        `SELECT r.id AS run_id, s->>'instance' AS instance, s->>'domain' AS domain
         FROM sim_runs r, jsonb_array_elements(r.profile->'shops') s
         WHERE r.id = ANY($1::text[])`,
        [[...new Set(rows.map((row) => row.run_id))]],
      );
      // Deliveries run in parallel; their outcomes are saved one by one on this connection.
      const outcomes = await Promise.all(
        rows.map(async (row) => {
          const shop =
            shops.find(
              (item) =>
                item.run_id === row.run_id && item.instance === row.instance,
            )?.domain ?? '';
          const payload = JSON.stringify(row.body);
          try {
            const response = await fetchImpl(row.url, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
              headers: {
                'content-type': 'application/json',
                'x-shopify-topic': row.topic,
                'x-shopify-shop-domain': shop,
                'x-shopify-api-version': '2026-07',
                'x-shopify-webhook-id': `${row.event_id}-${row.id}`,
                'x-shopify-event-id': row.event_id,
                'x-shopify-triggered-at': new Date().toISOString(),
                'x-shopify-hmac-sha256': createHmac('sha256', row.secret)
                  .update(payload)
                  .digest('base64'),
              },
              body: payload,
            });

            return { row, delivered: response.ok };
          } catch {
            return { row, delivered: false };
          }
        }),
      );
      for (const { row, delivered } of outcomes) {
        const attempts = row.attempts + 1;
        const retry = retryDelays[attempts - 1];
        await client.query(
          `UPDATE sim_webhooks SET attempts = $2, status = $3, due_at = $4 WHERE id = $1`,
          [
            row.id,
            attempts,
            delivered ? 'delivered' : retry ? 'pending' : 'failed',
            Date.now() + (retry ?? 0),
          ],
        );
        if (delivered || !retry)
          await client.query(
            `INSERT INTO sim_metrics (run_id, name, instance, bucket, value)
             SELECT $1, $2, $3, (now_ms / 60000) * 60000, 1 FROM (SELECT now FROM sim_runs WHERE id = $1) r(now_ms)
             ON CONFLICT (run_id, name, instance, bucket) DO UPDATE SET value = sim_metrics.value + 1`,
            [
              row.run_id,
              delivered ? 'webhooks.delivered' : 'webhooks.failed',
              row.instance,
            ],
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /** Stops delivering and waits for the current pass. */
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
