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
  close(): Promise<void>;
}

const SUBSCRIBER_PRIVATE_KEY =
  "3ad635dc380ed603e85842e163bb6a0f6af83110cf61c78785fab7bce173c105";

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
        const timeout = setTimeout(() => {
          stopSubscription(subscription);
          reject(new Error(`timeout waiting for event: ${JSON.stringify(filter)}`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeout);
          stopSubscription(subscription);
        };

        const subscription = ndk.subscribe(filter, { closeOnEose: false });
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
        const events: NDKEvent[] = [];
        const timeout = setTimeout(() => {
          stopSubscription(subscription);
          reject(new Error(`timeout waiting for ${count} events: ${JSON.stringify(filter)}`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeout);
          stopSubscription(subscription);
        };

        const subscription = ndk.subscribe(filter, { closeOnEose: false });
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
    async close() {
      closed = true;
      for (const subscription of activeSubscriptions) {
        subscription.stop();
      }
      activeSubscriptions.clear();
    },
  };
}
