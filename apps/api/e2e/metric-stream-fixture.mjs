import assert from 'node:assert/strict';

import { until } from './helpers.mjs';

/** Collects real SSE frames and releases the socket at test teardown. */
export async function metricStream(
  t,
  origin,
  f,
  user = f.owner,
  readOnChange = false,
  queryRequest = { path: `${f.base}/metrics/query`, body: {} },
) {
  const abort = new AbortController();
  t.onTestFinished(() => abort.abort());
  const response = await fetch(`${origin}${f.base}/metrics/events`, {
    headers: { cookie: user.cookie },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const events = [];
  let ended = false;
  let maxFrameBytes = 0;
  let receivedBytes = 0;
  let reading = false;
  let dirty = false;
  const readCosts = [];
  const readErrors = [];
  const readCurrent = async () => {
    dirty = true;
    if (reading) return;
    reading = true;
    while (dirty && !abort.signal.aborted) {
      dirty = false;
      const start = performance.now();
      const result = await fetch(`${origin}${queryRequest.path}`, {
        method: 'POST',
        headers: {
          cookie: user.cookie,
          origin: f.config.baseURL,
          'content-type': 'application/json',
        },
        body: JSON.stringify(queryRequest.body),
        signal: abort.signal,
      });
      assert.equal(result.status, 200);
      await result.json();
      readCosts.push(performance.now() - start);
    }
    reading = false;
  };
  const read = async () => {
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        receivedBytes += chunk.byteLength;
        buffer += new TextDecoder().decode(chunk);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(frame));
          const data = frame.match(/^data: (.+)$/m);
          if (data) {
            const event = JSON.parse(data[1]);
            events.push(event);
            if (readOnChange && event.refetch)
              void readCurrent().catch((error) => {
                if (!abort.signal.aborted) readErrors.push(error.message);
              });
          }
        }
      }
    } catch {
      /* Aborting a subscription closes its reader. */
    } finally {
      ended = true;
    }
  };
  void read();
  await until(() => events.length, 'initial stream event');

  return {
    events,
    get receivedBytes() {
      return receivedBytes;
    },
    get maxFrameBytes() {
      return maxFrameBytes;
    },
    readCosts,
    readErrors,
    close: () => abort.abort(),
    get ended() {
      return ended;
    },
  };
}
