import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKFilter,
  type NDKSubscription,
} from "@nostr-dev-kit/ndk";

export interface NdkSubscriber {
  publishTextNote(content: string): Promise<NDKEvent>;
  waitForEvent(filter: NDKFilter, timeoutMs: number): Promise<NDKEvent>;
  waitForEvents(
    filter: NDKFilter,
    count: number,
    timeoutMs: number,
  ): Promise<NDKEvent[]>;
  /**
   * Subscribe to the relay with `filter`, collect events for exactly `ms`
   * milliseconds, then resolve with all collected events. NEVER rejects on
   * timeout — resolves with an empty array when nothing arrives.
   *
   * Wire-level interpretation (AC-A14-8): trusts the relay to honour `#h`
   * tag filtering; does NOT attempt to decrypt kind-445 payloads or verify
   * MLS epoch transitions. If a future epic needs decryption-attempt form,
   * extend this fixture rather than modifying this method.
   *
   * Closes the subscription before resolving.
   */
  waitForDuration(filter: NDKFilter, ms: number): Promise<NDKEvent[]>;
  close(): Promise<void>;
}

// Shares User B's identity (rotated 2026-04-30); keep in sync with
// `e2e/global-setup.ts` and `auth-helper-b.ts`.
const SUBSCRIBER_PRIVATE_KEY =
  "645b5c22a215745146817311d96e09cd0e4890e9c9dae7774a6e517d468523b4";

export async function openNdkSubscriber(
  relays: string[],
): Promise<NdkSubscriber> {
  const ndk = new NDK({
    explicitRelayUrls: relays,
    signer: new NDKPrivateKeySigner(SUBSCRIBER_PRIVATE_KEY),
  });
  await ndk.connect(3000);

  let closed = false;
  const activeSubscriptions = new Set<NDKSubscription>();

  const ensureOpen = () => {
    if (closed) {
      throw new Error("subscriber closed");
    }
  };

  const stopSubscription = (subscription: NDKSubscription) => {
    subscription.stop();
    activeSubscriptions.delete(subscription);
  };

  return {
    async publishTextNote(content: string) {
      ensureOpen();
      const event = new NDKEvent(ndk);
      event.kind = 1;
      event.content = content;
      await event.publish();
      return event;
    },
    waitForEvent(filter, timeoutMs) {
      ensureOpen();
      return new Promise<NDKEvent>((resolve, reject) => {
        // Record subscription time so we can ignore any historical events
        // the relay replays before the test's actual dispatch. Group-state
        // kind-445 events (commits, welcome) from the earlier createGroup
        // call are already on the relay when task-publish-contract tests
        // subscribe; without this gate the subscription would resolve on
        // one of those rather than on the task event the test dispatches
        // next. Skip the auto-since if the caller already specified
        // `since` OR an `ids` filter — an ids filter already uniquely
        // identifies the target and must not be further constrained by
        // created_at (otherwise fast publish/subscribe races in the same
        // wall-clock second can drop the target event on platforms with
        // sub-second relay clock skew, e.g. macOS).
        const hasSince = filter.since != null;
        const hasIdsFilter =
          Array.isArray(filter.ids) && filter.ids.length > 0;
        const filterWithSince: NDKFilter =
          hasSince || hasIdsFilter
            ? filter
            : { ...filter, since: Math.floor(Date.now() / 1000) };

        const timeout = setTimeout(() => {
          stopSubscription(subscription);
          reject(new Error(`timeout waiting for event: ${JSON.stringify(filterWithSince)}`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeout);
          stopSubscription(subscription);
        };

        const subscription = ndk.subscribe(filterWithSince, { closeOnEose: false });
        activeSubscriptions.add(subscription);
        subscription.on("event", (event: NDKEvent) => {
          cleanup();
          resolve(event);
        });
        subscription.on("close", () => {
          clearTimeout(timeout);
        });
      });
    },
    waitForEvents(filter, count, timeoutMs) {
      ensureOpen();
      return new Promise<NDKEvent[]>((resolve, reject) => {
        const hasSince = filter.since != null;
        const hasIdsFilter =
          Array.isArray(filter.ids) && filter.ids.length > 0;
        const filterWithSince: NDKFilter =
          hasSince || hasIdsFilter
            ? filter
            : { ...filter, since: Math.floor(Date.now() / 1000) };

        const events: NDKEvent[] = [];
        const timeout = setTimeout(() => {
          stopSubscription(subscription);
          reject(new Error(`timeout waiting for ${count} events: ${JSON.stringify(filterWithSince)}`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeout);
          stopSubscription(subscription);
        };

        const subscription = ndk.subscribe(filterWithSince, { closeOnEose: false });
        activeSubscriptions.add(subscription);
        subscription.on("event", (event: NDKEvent) => {
          events.push(event);
          if (events.length >= count) {
            cleanup();
            resolve(events);
          }
        });
        subscription.on("close", () => {
          clearTimeout(timeout);
        });
      });
    },
    waitForDuration(filter, ms) {
      ensureOpen();
      return new Promise<NDKEvent[]>((resolve) => {
        const hasSince = filter.since != null;
        const hasIdsFilter =
          Array.isArray(filter.ids) && filter.ids.length > 0;
        const filterWithSince: NDKFilter =
          hasSince || hasIdsFilter
            ? filter
            : { ...filter, since: Math.floor(Date.now() / 1000) };

        const events: NDKEvent[] = [];

        const subscription = ndk.subscribe(filterWithSince, { closeOnEose: false });
        activeSubscriptions.add(subscription);
        subscription.on("event", (event: NDKEvent) => {
          events.push(event);
        });

        setTimeout(() => {
          stopSubscription(subscription);
          resolve(events);
        }, ms);
      });
    },
    async close() {
      closed = true;
      for (const subscription of activeSubscriptions) {
        subscription.stop();
      }
      activeSubscriptions.clear();
    },
  };
}
