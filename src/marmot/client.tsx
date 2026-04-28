import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import NDK, { NDKEvent, NDKRelay, NDKRelaySet } from "@nostr-dev-kit/ndk";
import {
  MarmotClient,
  createKeyPackageRelayListEvent,
  deserializeApplicationData,
  getNostrGroupIdHex,
  getPubkeyLeafNodeIndexes,
} from "@internet-privacy/marmot-ts";
import type {
  BaseGroupHistory,
  GroupHistoryFactory,
  SerializedClientState,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";

import { createKVStore, createInviteKVStore, getOrCreateClientId } from "./storage";
import { NdkNetworkAdapter } from "./network";
import { useDeviceSync } from "./device-sync";
import { computeDetachedGroupIds } from "./detached-groups";
import { removeLeafByIndex } from "./per-leaf-remove";

import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import { DEFAULT_RELAYS, NDK_CONNECT_TIMEOUT_MS } from "../config/relays";
import { computeAllGroupRelays } from "../lib/relay-utils";

function isTestRuntime(): boolean {
  return process.env.NEXT_PUBLIC_E2E === "1" || process.env.NODE_ENV === "test";
}

// Test-only in-memory history store. When `isTestRuntime()` is true, the
// MarmotClient is constructed with `testHistoryFactory` so that every call
// to `sendApplicationRumor` also saves the serialized application bytes into
// `testHistories`, keyed by the MLS group id (hex). The Playwright publish
// contract test reads these back via `window.__notestrTestSentRumors` and
// cross-checks that the bytes the web actually serialized match what was
// dispatched — i.e. the per-variant AC-*-1 matchers in
// `specs/epic-task-sync-publish-contract/acceptance-criteria.md`.
class TestGroupHistory implements BaseGroupHistory {
  messages: Uint8Array[] = [];

  async saveMessage(message: Uint8Array): Promise<void> {
    // Copy so later mutations to the caller's buffer do not leak in.
    this.messages.push(new Uint8Array(message));
  }

  async purgeMessages(): Promise<void> {
    this.messages = [];
  }
}

const testHistories = new Map<string, TestGroupHistory>();

function bytesToHexLower(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

const testHistoryFactory: GroupHistoryFactory<TestGroupHistory> = (
  groupId: Uint8Array,
) => {
  const idStr = bytesToHexLower(groupId);
  let history = testHistories.get(idStr);
  if (!history) {
    history = new TestGroupHistory();
    testHistories.set(idStr, history);
  }
  return history;
};

interface MarmotContextValue {
  client: MarmotClient | null;
  signer: EventSigner | null;
  groups: MarmotGroup[];
  pubkey: string;
  clientId: string;
  relays: string[];
  loading: boolean;
  error: Error | null;
  discoverable: boolean;
  detachedGroupIds: Set<string>;
}

const MarmotContext = createContext<MarmotContextValue>({
  client: null,
  signer: null,
  groups: [],
  pubkey: "",
  clientId: "",
  relays: DEFAULT_RELAYS,
  loading: true,
  error: null,
  discoverable: false,
  detachedGroupIds: new Set(),
});

interface MarmotProviderProps {
  signer: EventSigner;
  pubkey: string;
  relays?: string[];
  children: ReactNode;
}

export function MarmotProvider({
  signer,
  pubkey,
  relays: relaysProp,
  children,
}: MarmotProviderProps) {
  const relays = relaysProp ?? DEFAULT_RELAYS;
  const [state, setState] = useState<
    Pick<MarmotContextValue, "client" | "groups" | "loading" | "error" | "discoverable">
  >({
    client: null,
    groups: [],
    loading: true,
    error: null,
    discoverable: false,
  });

  const mountedRef = useRef(true);
  const clientRef = useRef<MarmotClient | null>(null);
  const ndkRef = useRef<NDK | null>(null);

  const init = useCallback(async () => {
    try {
      if (typeof globalThis.crypto?.subtle?.generateKey !== "function") {
        throw new Error(
          "Web Crypto API is not available. Please access this app over HTTPS.",
        );
      }

      const ndk = new NDK({ explicitRelayUrls: relays });
      ndkRef.current = ndk;
      await ndk.connect(NDK_CONNECT_TIMEOUT_MS);

      if (!mountedRef.current) return;

      // marmot-ts v0.5 takes raw GenericKeyValueStore handles directly
      // — the previous KeyValueGroupStateBackend / KeyPackageStore wrappers
      // were collapsed into the manager classes (KeyPackageStore was merged
      // into KeyPackageManager; group state storage now lives on
      // GroupsManager). We persist invite state in IndexedDB too so the
      // InviteManager survives reloads instead of falling back to the
      // in-memory default.
      const groupStateStore = createKVStore<SerializedClientState>("group-state");
      const keyPackageStore = createKVStore<StoredKeyPackage>("key-packages");
      const inviteStore = createInviteKVStore();

      const network = new NdkNetworkAdapter(ndk, relays);
      const clientId = await getOrCreateClientId();

      // In test runtime, install the in-memory history factory so the
      // publish contract test can read back the rumor bytes that were
      // serialized for each dispatched TaskEvent. The factory is cast to the
      // default-generic shape the rest of the app uses; the extra methods on
      // TestGroupHistory are not consumed outside the test hook.
      const baseOptions = {
        signer,
        groupStateStore,
        keyPackageStore,
        inviteStore,
        network,
        clientId,
      };
      const client = isTestRuntime()
        ? (new MarmotClient({
            ...baseOptions,
            historyFactory: testHistoryFactory,
          }) as unknown as MarmotClient)
        : new MarmotClient(baseOptions);
      clientRef.current = client;

      if (!mountedRef.current) return;

      const groups = await client.groups.loadAll();

      if (!mountedRef.current) return;

      // Ensure NDK pool covers all per-group relays
      const allRelays = computeAllGroupRelays(groups, relays);
      for (const url of allRelays) {
        if (!ndk.pool.relays.has(url)) {
          ndk.pool.addRelay(new NDKRelay(url, undefined, ndk), true);
        }
      }

      // Force re-render when any group's internal state changes (e.g. after
      // invite, selfUpdate, or ingest). GroupsManager only emits "updated"
      // when groups are added/removed, not when a group mutates its MLS state.
      //
      // Also emit a diagnostic log on every epoch transition so the next
      // regression in the live-delivery pipeline is directly observable
      // without re-instrumenting the code. Ratchet-only advances (within
      // the same epoch) are logged distinctly from epoch transitions —
      // only the latter should trigger retry-queue draining in device-sync.
      const stateListenerGroups = new Set<string>();
      const previousEpoch = new Map<string, bigint>();
      const attachStateListener = (group: MarmotGroup) => {
        if (stateListenerGroups.has(group.idStr)) return;
        stateListenerGroups.add(group.idStr);
        previousEpoch.set(group.idStr, group.state.groupContext.epoch);
        group.on("stateChanged", () => {
          const prev = previousEpoch.get(group.idStr) ?? 0n;
          const next = group.state.groupContext.epoch;
          previousEpoch.set(group.idStr, next);
          console.debug("[mls-receive:state-changed]", {
            groupId: group.idStr.slice(0, 8),
            prevEpoch: prev.toString(),
            newEpoch: next.toString(),
            reason: next === prev ? "ratchet" : "epoch",
          });
          if (mountedRef.current) {
            setState((prev) => ({ ...prev, groups: [...prev.groups] }));
          }
        });
      };
      for (const group of groups) attachStateListener(group);

      // Make client available immediately — key package work runs in background
      setState({ client, groups, loading: false, error: null, discoverable: false });

      client.groups.on("updated", (updatedGroups) => {
        if (mountedRef.current) {
          // Add any new per-group relays to the NDK pool
          const updated = computeAllGroupRelays(updatedGroups, relays);
          for (const url of updated) {
            if (!ndk.pool.relays.has(url)) {
              ndk.pool.addRelay(new NDKRelay(url, undefined, ndk), true);
            }
          }
          for (const group of updatedGroups) attachStateListener(group);
          setState((prev) => ({ ...prev, groups: updatedGroups }));
        }
      });

      // Rotate consumed key packages after joining a group
      client.groups.on("joined", async () => {
        if (!mountedRef.current) return;
        try {
          const packages = await client.keyPackages.list();
          const usedCount = packages.filter((p) => p.used).length;
          console.debug("[marmot] groupJoined — rotating", usedCount, "used key packages");
          for (const pkg of packages.filter((p) => p.used)) {
            await client.keyPackages.rotate(pkg.keyPackageRef, { relays });
          }
          // Re-evaluate discoverability
          const updated = await client.keyPackages.list();
          const nowDiscoverable = updated.some(
            (p) => !p.used && p.published && p.published.length > 0,
          );
          if (mountedRef.current) {
            setState((prev) => ({ ...prev, discoverable: nowDiscoverable }));
          }
        } catch (err) {
          console.error("[marmot] groupJoined key package rotation failed:", err);
        }
      });

      // --- Background: key package readiness & relay list publish ---
      (async () => {
        try {
          const existingPackages = await client.keyPackages.list();
          const hasUsable = existingPackages.some(
            (p) => !p.used && p.published && p.published.length > 0,
          );

          console.debug(
            "[marmot] key packages:",
            existingPackages.length,
            "total,",
            existingPackages.filter((p) => !p.used).length,
            "unused,",
            "hasUsable:",
            hasUsable,
          );

          if (!hasUsable && relays.length > 0) {
            console.debug("[marmot] creating key package for relays:", relays);
            await client.keyPackages.create({ relays });
            console.debug("[marmot] key package created successfully");
          }

          // Delete stale legacy kind 443 key package events whose private
          // keys are no longer in local IndexedDB (e.g. after clearing
          // browser data). Kind 30443 events are addressable and may belong
          // to other live sibling devices of the same identity, so they
          // must NOT be deleted here — auto-invite handles dedup by `d`
          // slot instead.
          if (relays.length > 0 && ndk) {
            try {
              const remoteKPs = await network.request(relays, [
                { kinds: [443 as any], authors: [pubkey] } as any,
              ]);
              const localList = await client.keyPackages.list();
              // v0.5 normalizes `published` to [] inside the listing snapshot,
              // but the type still has it optional — coerce so this stays
              // honest if upstream tightens the type later.
              const localPublishedIds = new Set(
                localList.flatMap((kp) => (kp.published ?? []).map((e) => e.id)),
              );
              const staleIds = remoteKPs
                .map((e) => e.id as string)
                .filter((id) => !localPublishedIds.has(id));

              if (staleIds.length > 0) {
                console.debug(
                  "[marmot] deleting",
                  staleIds.length,
                  "stale legacy kind 443 KP events from relays",
                );
                const deleteEvent = {
                  kind: 5,
                  created_at: Math.floor(Date.now() / 1000),
                  tags: [
                    ...staleIds.map((id) => ["e", id]),
                    ["k", "443"],
                  ],
                  content: "",
                  pubkey,
                };
                const signed = await signer.signEvent(deleteEvent as any);
                const ndkEvent = new NDKEvent(ndk, signed as any);
                const relaySet = NDKRelaySet.fromRelayUrls(relays, ndk);
                await ndkEvent.publish(relaySet).catch(() => {});
              }
            } catch {
              // Non-fatal: stale KP cleanup is best-effort
            }
          }

          // Publish kind 10051 relay list only if relay doesn't already have one
          if (relays.length > 0 && ndk) {
            const existing10051 = await network.request(relays, [
              { kinds: [10051 as any], authors: [pubkey], limit: 1 } as any,
            ]);

            if (existing10051.length === 0) {
              console.debug("[marmot] publishing kind 10051 relay list");
              const unsigned = createKeyPackageRelayListEvent({
                pubkey,
                relays,
              });
              const signed = await signer.signEvent(unsigned);
              const ndkEvent = new NDKEvent(ndk, signed);
              const relaySet = NDKRelaySet.fromRelayUrls(relays, ndk);
              await ndkEvent.publish(relaySet).catch((err) => {
                console.warn("[marmot] kind 10051 publish failed:", err);
              });
            } else {
              console.debug("[marmot] kind 10051 already exists on relay");
            }
          }

          if (!mountedRef.current) return;

          // Re-evaluate after background work completes
          const updated = await client.keyPackages.list();
          const nowDiscoverable = updated.some(
            (p) => !p.used && p.published && p.published.length > 0,
          );
          console.debug("[marmot] discoverable:", nowDiscoverable);
          setState((prev) => ({ ...prev, discoverable: nowDiscoverable }));
        } catch (err) {
          console.error("[marmot] key package background init failed:", err);
        }
      })();
    } catch (err) {
      if (mountedRef.current) {
        setState({
          client: null,
          groups: [],
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
          discoverable: false,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer]);

  useEffect(() => {
    mountedRef.current = true;
    init();

    return () => {
      mountedRef.current = false;
      const c = clientRef.current;
      if (c) {
        // MarmotClient itself is no longer an EventEmitter in v0.5; events
        // live on its sub-managers. Detach from each so we don't leak
        // listeners that capture this provider's state.
        c.groups.removeAllListeners();
        c.invites.removeAllListeners();
        c.keyPackages.removeAllListeners();
      }
      clientRef.current = null;
      // NDK doesn't expose a clean pool.disconnect() — just drop the reference
      ndkRef.current = null;
    };
  }, [init]);

  useDeviceSync(state.client, pubkey, relays, signer);

  useEffect(() => {
    if (!isTestRuntime() || !state.client) return;

    window.__notestrTestGroups = () =>
      state.groups.map((group) => ({
        idStr: group.idStr,
        nostrGroupIdHex: getNostrGroupIdHex(group.state),
        relays: group.relays ?? relays,
      }));
    window.__notestrTestPubkey = () => pubkey;
    window.__notestrTestSentRumors = (groupId: string) => {
      const history = testHistories.get(groupId);
      if (!history) return [];
      return history.messages.map((bytes) => deserializeApplicationData(bytes));
    };
    window.__notestrTestResetSentRumors = (groupId: string) => {
      const history = testHistories.get(groupId);
      if (history) history.messages = [];
    };
    window.__notestrTestNetworkRequest = async (reqRelays, filters) => {
      if (!state.client) return [];
      return state.client.network.request(
        reqRelays,
        filters as Parameters<typeof state.client.network.request>[1],
      );
    };
    window.__notestrTestForgetLeaf = async (groupId, leafIndex) => {
      const group = state.groups.find((entry) => entry.idStr === groupId);
      if (!group) throw new Error(`group ${groupId} not loaded`);
      await removeLeafByIndex(group, leafIndex);
    };
    window.__notestrTestPubkeyLeafIndexes = (groupId, pubkeyHex) => {
      const group = state.groups.find((entry) => entry.idStr === groupId);
      if (!group) return [];
      return getPubkeyLeafNodeIndexes(group.state, pubkeyHex);
    };
    window.__notestrTestInspectGroupEvent = async (groupId, eventId) => {
      const group = state.groups.find((entry) => entry.idStr === groupId);
      if (!group) {
        return {
          event: null,
          firstIngest: [],
          secondIngest: [],
          rumor: null,
        };
      }

      // Capture the group's current epoch first — we want this even if
      // the requested event doesn't exist on the relay, so diagnostics
      // can query "what's my epoch" with a dummy eventId.
      const currentEpoch = group.state.groupContext.epoch.toString();

      const [event] = await state.client!.network.request(
        group.relays ?? relays,
        [{ ids: [eventId] }],
      );
      if (!event) {
        return {
          event: null,
          firstIngest: [],
          secondIngest: [],
          rumor: null,
          currentEpoch,
        };
      }

      const collect = async () => {
        const results: Array<{
          kind: string;
          reason?: string;
          errorMessages?: string[];
        }> = [];
        for await (const result of group.ingest([event])) {
          const entry: {
            kind: string;
            reason?: string;
            errorMessages?: string[];
          } = {
            kind: result.kind,
            reason: "reason" in result ? result.reason : undefined,
          };
          if ("errors" in result && Array.isArray(result.errors)) {
            entry.errorMessages = result.errors.map((e) =>
              e instanceof Error
                ? `${e.name}: ${e.message}`
                : typeof e === "object" && e !== null && "message" in e
                  ? String((e as { message: unknown }).message)
                  : String(e),
            );
          }
          results.push(entry);
        }
        return results;
      };

      // The sender sees its own kind-445 as a `self-echo` and `ingest` skips
      // it without emitting `applicationMessage`, so we can't round-trip the
      // ciphertext to plaintext via the live group. Instead we pull the
      // serialized application bytes straight out of the test-only history
      // store — those bytes are exactly what went into the ChaCha20-Poly1305
      // envelope, so deserializing them yields the rumor that was published.
      const history = testHistories.get(group.idStr);
      const rumor = history?.messages.length
        ? deserializeApplicationData(
            history.messages[history.messages.length - 1]!,
          )
        : null;

      return {
        event,
        firstIngest: await collect(),
        secondIngest: await collect(),
        rumor,
        currentEpoch: group.state.groupContext.epoch.toString(),
      };
    };

    return () => {
      delete window.__notestrTestGroups;
      delete window.__notestrTestPubkey;
      delete window.__notestrTestNetworkRequest;
      delete window.__notestrTestInspectGroupEvent;
      delete window.__notestrTestSentRumors;
      delete window.__notestrTestResetSentRumors;
      delete window.__notestrTestForgetLeaf;
      delete window.__notestrTestPubkeyLeafIndexes;
    };
  }, [pubkey, relays, state.client, state.groups]);

  const detachedGroupIds = useMemo(
    () => computeDetachedGroupIds(state.groups, pubkey),
    [state.groups, pubkey],
  );

  const contextValue: MarmotContextValue = {
    ...state,
    signer,
    pubkey,
    clientId: state.client?.keyPackages.clientId ?? "",
    relays,
    detachedGroupIds,
  };

  return (
    <MarmotContext.Provider value={contextValue}>
      {children}
    </MarmotContext.Provider>
  );
}

export function useMarmot(): MarmotContextValue {
  return useContext(MarmotContext);
}

export function useGroup(
  groupId: string | undefined,
): MarmotGroup | undefined {
  const { groups } = useMarmot();
  if (!groupId) return undefined;
  return groups.find((g) => g.idStr === groupId);
}
