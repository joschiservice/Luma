import { type WorkspaceTopic, workspaceTopics } from '@luma/api-contract';
import { subscribeToMetrics } from '@luma/api-contract/client';

type Subscriber = Pick<
  Parameters<typeof subscribeToMetrics>[0],
  'onResync' | 'onError'
>;

type MetricEvent = Parameters<Subscriber['onResync']>[0];

/**
 * The shortest interval between live reads of one dashboard view. The first change after a quiet
 * period reads at once; further changes wait for the interval, so a busy workspace refreshes each
 * view about once per interval rather than once per change.
 */
export const liveRefreshMs = 2000;

/** Returns how long a change must wait when the view's last read started at `lastReadAt`. */
export function liveRefreshDelay(lastReadAt: number) {
  return Math.max(0, lastReadAt + liveRefreshMs - Date.now());
}

/** Reports whether an event asks views that depend on any of these areas to read again. */
export function changesAny(
  event: MetricEvent,
  topics: readonly WorkspaceTopic[],
) {
  return (
    event.refetch &&
    event.topics.some((topic) => (topics as readonly string[]).includes(topic))
  );
}

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
      // A late consumer has not read since the stream opened, so it reconciles every area.
      else if (lastEvent)
        subscriber.onResync({
          ...lastEvent,
          refetch: true,
          topics: [...workspaceTopics],
        });

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
