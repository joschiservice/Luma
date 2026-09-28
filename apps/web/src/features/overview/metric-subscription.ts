import { subscribeToMetrics } from '@luma/api-contract/client';

type Subscriber = Pick<
  Parameters<typeof subscribeToMetrics>[0],
  'onResync' | 'onError'
>;

type MetricEvent = Parameters<Subscriber['onResync']>[0];

const subscriptions = new Map<string, ReturnType<typeof createSubscription>>();

function createSubscription(organizationId: string) {
  const subscribers = new Set<Subscriber>();
  let lastEvent: MetricEvent | undefined;
  let stop = () => {
    /* Assigned when the first subscriber opens the stream. */
  };
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let lastEventAt = Date.now();
  let lastFallbackAt = Date.now();
  let interrupted = false;

  const error = () => {
    interrupted = true;
    lastEvent = undefined;
    for (const subscriber of subscribers) subscriber.onError();
  };
  const open = () => {
    stop();
    clearTimeout(retry);
    if (!navigator.onLine) {
      error();

      return;
    }
    lastEventAt = Date.now();
    stop = subscribeToMetrics({
      baseUrl: '/api',
      organizationId,
      onResync: (event) => {
        interrupted = false;
        lastEvent = event;
        lastEventAt = Date.now();
        retryDelay = 1000;
        for (const subscriber of subscribers) subscriber.onResync(event);
      },
      onError: () => {
        stop();
        error();
        clearTimeout(retry);
        if (subscribers.size && navigator.onLine) {
          retry = setTimeout(open, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
      },
    });
  };
  const offline = () => {
    stop();
    clearTimeout(retry);
    error();
  };
  const fallback = setInterval(() => {
    const stale = Date.now() - lastEventAt > 12000;
    if (stale && !interrupted) error();
    if (!lastEvent?.connected && Date.now() - lastFallbackAt >= 30000) {
      lastFallbackAt = Date.now();
      error();
      if (stale) open();
    }
  }, 5000);
  window.addEventListener('online', open);
  window.addEventListener('offline', offline);

  return {
    add(subscriber: Subscriber) {
      let active = true;
      subscribers.add(subscriber);
      if (subscribers.size === 1) open();
      else if (lastEvent) subscriber.onResync({ ...lastEvent, refetch: true });

      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
        if (subscribers.size) return;
        stop();
        clearTimeout(retry);
        clearInterval(fallback);
        window.removeEventListener('online', open);
        window.removeEventListener('offline', offline);
        subscriptions.delete(organizationId);
      };
    },
  };
}

/** Shares one workspace stream in this page and closes it when the last consumer leaves. */
export function subscribeToWorkspaceMetrics(
  organizationId: string,
  subscriber: Subscriber,
) {
  let subscription = subscriptions.get(organizationId);
  if (!subscription) {
    subscription = createSubscription(organizationId);
    subscriptions.set(organizationId, subscription);
  }

  return subscription.add(subscriber);
}
