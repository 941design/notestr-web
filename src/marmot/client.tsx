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

import NDK, { NDKEvent, NDKRelay, NDKRelayAuthPolicies, NDKRelaySet } from "@nostr-dev-kit/ndk";
import { EventSignerNdkAdapter } from "./event-signer-ndk-adapter";
import {
  MarmotClient,
  createKeyPackageRelayListEvent,
  deserializeApplicationData,
  getGroupMembers,
  getNostrGroupIdHex,
  getPubkeyLeafNodeIndexes,
  getPubkeyLeafNodes,
  isAdmin,
} from "@internet-privacy/marmot-ts";
import type {
  BaseGroupHistory,
  GroupHistoryFactory,
  SerializedClientState,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";

import {
  createKVStore,
  createInviteKVStore,
  getOrCreateClientId,
  bindStores,
  unbindStores,
  getActivePubkey,
  migrateLegacyPartition,
} from "./storage";
import { loadFailedWelcomes } from "./failed-welcomes";
import { NdkNetworkAdapter } from "./network";
import { useDeviceSync, groupHasKeyPackageLeaf } from "./device-sync";
import { mlsTrace } from "./mls-trace";
import { computeDetachedGroupIds } from "./detached-groups";
import { removeLeafByIndex } from "./per-leaf-remove";
import { resetOutboxEntriesForIdentityChange } from "../integration/marmot-adapter";

import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import { DEFAULT_RELAYS, NDK_CONNECT_TIMEOUT_MS } from "../config/relays";
import { computeAllGroupRelays } from "../lib/relay-utils";
import { shouldRunProbe } from "./probe-gate";

// Probe-gating timestamp store. Routed through the per-pubkey partitioned
// `createKVStore("identity")` (NOT a direct origin-only createStore) so the
// probe gate reads/writes the active identity's partition — accessed only
// inside the post-auth probe effect below, after bindStores has run.
const probeIdentityStore = createKVStore<string>("identity");

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
  /** 0 = no banner; >0 = number of potentially undelivered invitations found by probe */
  probeBannerCount: number;
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
  probeBannerCount: 0,
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

  // Bind the per-pubkey IDB partition synchronously at render — BEFORE any
  // descendant (e.g. TaskStoreProvider, which calls loadEvents on mount for a
  // restored group) can touch a store. Doing this only in the async init()
  // below is too late: children mount and run their effects before init()
  // awaits past ndk.connect, so an unbound store would reject. bindStores is
  // idempotent and writes only a module global; async migration stays in init().
  if (pubkey && getActivePubkey() !== pubkey) {
    bindStores(pubkey);
  }

  const [state, setState] = useState<
    Pick<MarmotContextValue, "client" | "groups" | "loading" | "error" | "discoverable" | "probeBannerCount">
  >({
    client: null,
    groups: [],
    loading: true,
    error: null,
    discoverable: false,
    probeBannerCount: 0,
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

      // AC-GUARD-1: only set AUTH wiring when a signer is present.
      // AC-WIRE-4: both assignments are before ndk.connect() to avoid a race
      // window where an AUTH challenge arrives before the policy is installed.
      if (signer) {
        ndk.signer = new EventSignerNdkAdapter(signer, pubkey);
        ndk.relayAuthDefaultPolicy = NDKRelayAuthPolicies.signIn({ ndk });
      }

      await ndk.connect(NDK_CONNECT_TIMEOUT_MS);

      if (!mountedRef.current) return;

      // Stores are already bound synchronously at render (see top of
      // MarmotProvider). Run the one-shot legacy migration before the client
      // loads group-state / key-packages so an existing single-user browser's
      // groups and MLS leaf carry across the upgrade.
      bindStores(pubkey); // idempotent re-assert (harmless; keeps the invariant explicit)
      await migrateLegacyPartition(pubkey);

      if (!mountedRef.current) return;

      // marmot-ts v0.5 takes raw GenericKeyValueStore handles directly
      // — the previous KeyValueGroupStateBackend / KeyPackageStore wrappers
      // were collapsed into the manager classes (KeyPackageStore was merged
      // into KeyPackageManager; group state storage now lives on
      // GroupsManager). We persist invite state in IndexedDB too so the
      // InviteManager survives reloads instead of falling back to the
      // in-memory default.
      // Pin these client-owned stores to THIS pubkey's partition so an
      // in-flight task from a signed-out identity can never resolve into a
      // newly signed-in identity's partition (P1-A cross-account corruption).
      const groupStateStore = createKVStore<SerializedClientState>("group-state", pubkey);
      const keyPackageStore = createKVStore<StoredKeyPackage>("key-packages", pubkey);
      const inviteStore = createInviteKVStore(pubkey);

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
          if (mountedRef.current) {
            setState((prev) => ({ ...prev, groups: [...prev.groups] }));
          }
        });
      };
      for (const group of groups) attachStateListener(group);

      // Make client available immediately — key package work runs in background
      setState({ client, groups, loading: false, error: null, discoverable: false, probeBannerCount: 0 });

      // AC-PROBE-2: probe launches AFTER loading:false — never blocks the init path.
      // AC-OBS-2: no-op when pubkey is empty (unauthenticated).
      void (async () => {
        if (!pubkey || !client) return;

        // AC-PROBE-1 gating: run at most once per 24 hours per browser session.
        const lastProbeAtRaw = await probeIdentityStore.getItem("lastProbeAt");
        const lastProbeAtParsed = lastProbeAtRaw !== null ? Number(lastProbeAtRaw) : null;
        // Treat NaN (corrupt IDB value) as absent so the probe always runs in that case.
        const lastProbeAt = lastProbeAtParsed !== null && isNaN(lastProbeAtParsed) ? null : lastProbeAtParsed;
        if (!shouldRunProbe(lastProbeAt)) {
          // Fresh probe — skip.
          return;
        }

        try {
          // AC-PROBE-1.1: fetch kind-1059 gift wraps for this pubkey over last 14 days.
          const since = Math.floor(Date.now() / 1000) - 14 * 86400;
          const wraps = await client.network.request(
            DEFAULT_RELAYS,
            [{ kinds: [1059], "#p": [pubkey], since } as any],
          );
          const wrapCount = wraps.length;

          // AC-PROBE-1.2: compare against failed-welcome records + already loaded groups.
          const failedWelcomes = await loadFailedWelcomes({ since: since * 1000 });
          const failedCount = failedWelcomes.length;
          const groupCount = client.groups.loaded.length;

          // AC-PROBE-1.3: surface banner only when there is a material gap.
          if (wrapCount > failedCount + groupCount) {
            const gap = wrapCount - failedCount - groupCount;
            if (mountedRef.current) {
              setState((prev) => ({ ...prev, probeBannerCount: gap }));
            }
          }
        } finally {
          // AC-PROBE-1.5: always record the probe time so gating works next visit.
          await probeIdentityStore.setItem("lastProbeAt", String(Date.now()));
        }
      })().catch(console.error);

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
          probeBannerCount: 0,
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
      // Unbind the per-pubkey IDB partition on sign-out / identity switch, so a
      // subsequent access without a fresh bindStores throws rather than silently
      // resolving the prior user's partition.
      unbindStores();
      // S10-2: the outbox bridge's in-memory OutboxEntry registry
      // (src/integration/marmot-adapter.ts) is process-global module state
      // with no other identity-scoped teardown path — clear it here so a
      // prior identity's publish intents don't linger into the next
      // identity's session (compounds S10-1's unbounded-growth exposure).
      resetOutboxEntriesForIdentityChange();
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

    // AC-HOOK-6 / AC-HOOK-7: install the trace-dump test hook only when
    // BOTH conditions hold:
    //   1. isTestRuntime() (NEXT_PUBLIC_E2E=1 or NODE_ENV=test) — keeps
    //      the hook off in production builds even if a user's local
    //      environment happened to set the trace flag.
    //   2. process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" at build time.
    //      Next inlines NEXT_PUBLIC_* env vars at build time, so when
    //      the flag is unset webpack DCE removes this branch entirely
    //      (the install-block, the cleanup-block, and the captured
    //      `mlsTrace` reference at the call site).
    if (process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1") {
      window.__notestrTestMlsTrace = () => mlsTrace.dump();
    }

    // AC-REG-2: inject a synthetic sibling KeyPackage event into the
    // auto-invite scan. Mirrors the core of `inviteToAllGroups` in
    // device-sync.ts (which is closure-private to `useDeviceSync`) —
    // iterates loaded groups, skips non-admin / already-has-leaf groups,
    // and calls `group.inviteByKeyPackageEvent`. Used by S7's F2
    // regression test to force the commit+app-message race on B's side.
    //
    // The injected event's `pubkey` field (Nostr event author) is used
    // for admin-check filtering; the KP content must be a valid MLS
    // KeyPackage (marmot-ts validates it inside `inviteByKeyPackageEvent`).
    // The pubkey guard ensures the hook only invites same-identity siblings
    // (mirrors the device-sync auto-invite pubkey check). The hook is
    // gated by `isTestRuntime()` so it is unreachable in production.
    // S5: expose the forgotten-slots IDB store to e2e tests so sibling-forget
    // specs can assert a slot was written without reading IDB directly.
    window.__notestrTestForgottenSlots = async () => {
      const { loadForgottenSlots } = await import("./forgotten-slots");
      const slots = await loadForgottenSlots();
      return Array.from(slots);
    };

    window.__notestrTestGroupEpoch = (groupId: string): number | null => {
      const entry = state.groups.find((e) => e.idStr === groupId);
      if (!entry) return null;
      return Number(entry.state.groupContext.epoch);
    };
    window.__notestrTestGroupMembers = (groupId: string): string[] | null => {
      const entry = state.groups.find((e) => e.idStr === groupId);
      if (!entry) return null;
      return getGroupMembers(entry.state).slice().sort();
    };
    window.__notestrTestPubkeyLeafCount = (groupId: string, pubkeyHex: string): number => {
      const entry = state.groups.find((e) => e.idStr === groupId);
      if (!entry) return 0;
      return getPubkeyLeafNodes(entry.state, pubkeyHex).length;
    };

    window.__notestrTestArmAutoInvite = async (siblingKpEvent) => {
      if (!state.client) return;
      // Only proceed if the synthetic event is authored by the current
      // user — mirrors the pubkey guard in device-sync's auto-invite scan.
      if (siblingKpEvent.pubkey !== pubkey) return;
      for (const group of state.client.groups.loaded) {
        const gd = group.groupData;
        if (!gd || !isAdmin(gd, pubkey)) continue;
        if (groupHasKeyPackageLeaf(group.state, siblingKpEvent)) continue;
        try {
          await group.inviteByKeyPackageEvent(siblingKpEvent);
        } catch (err) {
          console.debug("[test-hook] __notestrTestArmAutoInvite invite failed:", err);
        }
      }
    };

    return () => {
      delete window.__notestrTestGroups;
      delete window.__notestrTestPubkey;
      delete window.__notestrTestNetworkRequest;
      if (process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1") {
        delete window.__notestrTestMlsTrace;
      }
      delete window.__notestrTestArmAutoInvite;
      delete window.__notestrTestInspectGroupEvent;
      delete window.__notestrTestSentRumors;
      delete window.__notestrTestResetSentRumors;
      delete window.__notestrTestForgetLeaf;
      delete window.__notestrTestPubkeyLeafIndexes;
      delete window.__notestrTestGroupEpoch;
      delete window.__notestrTestGroupMembers;
      delete window.__notestrTestPubkeyLeafCount;
      delete window.__notestrTestForgottenSlots;
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
      {state.probeBannerCount > 0 && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            background: "#fffbeb",
            border: "1px solid #f59e0b",
            borderRadius: "0.375rem",
            padding: "0.75rem 1rem",
            margin: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          You have {state.probeBannerCount} invitation{state.probeBannerCount !== 1 ? "s" : ""} that may not have been delivered to this device. Open Pending Invitations to check.
        </div>
      )}
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
