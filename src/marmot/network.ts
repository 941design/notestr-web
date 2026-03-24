import NDK, {
  NDKEvent,
  NDKRelaySet,
  type NDKFilter,
  type NDKSubscription,
} from "@nostr-dev-kit/ndk";

import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
  Observer,
  Unsubscribable,
} from "@internet-privacy/marmot-ts";

/**
 * Adapts an NDK instance to the NostrNetworkInterface required by MarmotClient.
 *
 * All relay targeting is done via NDKRelaySet so that each call routes
 * to exactly the relays the caller specifies, regardless of how the
 * underlying NDK pool is configured.
 */
export class NdkNetworkAdapter implements NostrNetworkInterface {
  constructor(
    private readonly ndk: NDK,
    private readonly defaultRelays: string[] = [],
  ) {}

  /**
   * Publishes a raw Nostr event to the specified relays.
   *
   * Creates an NDKEvent from the raw event, builds a relay set from the
   * given URLs, and publishes through NDK. Returns a per-relay result map.
   *
   * The publish MUST be awaited — marmot-ts checks the response via hasAck()
   * and only advances local MLS state (merge pending commit) when at least
   * one relay confirms with a NIP-20 OK. Fire-and-forget would break the
   * publish-then-merge invariant: local epoch advances but the commit never
   * reaches the relay, leaving other group members stuck on the old epoch.
   * MDK (Rust) and WhiteNoise enforce the same ordering.
   */
  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    const ndkEvent = new NDKEvent(this.ndk, event);
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk);

    const results: Record<string, PublishResponse> = {};

    try {
      // Timeout is required — NDK waits for relay OK indefinitely without one,
      // which stalls the entire commit/invite flow if a relay is unresponsive.
      const publishedRelays = await ndkEvent.publish(relaySet, 10_000);

      for (const relay of publishedRelays) {
        results[relay.url] = { from: relay.url, ok: true };
      }

      // Mark relays that were targeted but did not confirm as failed
      for (const url of relays) {
        if (!(url in results)) {
          results[url] = { from: url, ok: false, message: "No confirmation" };
        }
      }
    } catch (err) {
      // If publishing throws, mark all targeted relays as failed
      for (const url of relays) {
        if (!(url in results)) {
          results[url] = {
            from: url,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    return results;
  }

  /**
   * Performs a one-shot REQ against the specified relays.
   *
   * Opens a subscription with `closeOnEose: true`, collects every event
   * until EOSE, then resolves with the collected raw events.
   */
  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const ndkFilters: NDKFilter[] = Array.isArray(filters)
      ? (filters as NDKFilter[])
      : [filters as NDKFilter];
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk);

    return new Promise<NostrEvent[]>((resolve) => {
      const events: NostrEvent[] = [];

      const sub: NDKSubscription = this.ndk.subscribe(
        ndkFilters,
        { closeOnEose: true },
        relaySet,
      );

      sub.on("event", (ndkEvent: NDKEvent) => {
        events.push(ndkEvent.rawEvent() as NostrEvent);
      });

      sub.on("eose", () => {
        resolve(events);
      });

      // Safety: resolve after a generous timeout in case EOSE never fires
      const timeout = setTimeout(() => {
        sub.stop();
        resolve(events);
      }, 15_000);

      sub.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Opens a persistent subscription against the specified relays.
   *
   * Returns a Subscribable that follows the interop Observable contract
   * used by marmot-ts. Each incoming NDKEvent is converted to a raw
   * NostrEvent before being forwarded to the observer.
   */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const ndkFilters: NDKFilter[] = Array.isArray(filters)
      ? (filters as NDKFilter[])
      : [filters as NDKFilter];
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk);

    return {
      subscribe: (observer: Partial<Observer<NostrEvent>>): Unsubscribable => {
        const sub: NDKSubscription = this.ndk.subscribe(
          ndkFilters,
          { closeOnEose: false },
          relaySet,
        );

        sub.on("event", (ndkEvent: NDKEvent) => {
          try {
            observer.next?.(ndkEvent.rawEvent() as NostrEvent);
          } catch (err) {
            observer.error?.(err);
          }
        });

        sub.on("eose", () => {
          // Persistent subscriptions do not complete on EOSE
        });

        sub.on("close", () => {
          observer.complete?.();
        });

        return {
          unsubscribe(): void {
            sub.stop();
          },
        };
      },
    };
  }

  /**
   * Fetches inbox relays for a user from their kind 10051 relay list.
   *
   * Queries the connected relay pool for the most recent kind 10051
   * event authored by the given pubkey and extracts relay URLs from
   * all "relay" tags.
   */
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    const events = await this.request(this.defaultRelays, [
      {
        kinds: [10051 as any],
        authors: [pubkey],
        limit: 1,
      } as NDKFilter,
    ]);

    if (events.length === 0) return this.defaultRelays;

    // Sort descending by created_at to pick the freshest event
    const latest = events.sort(
      (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
    )[0];

    return latest.tags
      .filter((tag) => tag[0] === "relay" && typeof tag[1] === "string")
      .map((tag) => tag[1]);
  }
}
