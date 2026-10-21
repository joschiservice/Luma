import { buildRuntimeApp } from '@luma/application-runtime';

/**
 * Prepares the concurrent load that the live Insights journeys and their performance scenarios
 * share. The API runs in two processes, `subscribe` opens five more metric streams (two on the
 * first process, three on the second) and the web app talks to the first process. Returns the
 * streams and a browser context signed in as the workspace owner.
 */
export async function liveInsights(t, web, f, viewport, subscribe) {
  const api = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const second = await buildRuntimeApp(f.config);
  t.onTestFinished(() => second.close());
  const other = await second.listen({ host: '127.0.0.1', port: 0 });
  const subscriptions = await Promise.all(
    Array.from({ length: 5 }, (_, i) => subscribe(i < 2 ? api : other, i)),
  );
  await web.route(api);
  const context = await t.newContext({ baseURL: web.origin, viewport });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: web.origin };
    }),
  );

  return { subscriptions, context };
}
