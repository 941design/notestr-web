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
  KeyValueGroupStateBackend,
  KeyPackageStore,
  createKeyPackageRelayListEvent,
} from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";

import { createKVStore } from "./storage";
import { NdkNetworkAdapter } from "./network";
import { useDeviceSync } from "./device-sync";
import { computeDetachedGroupIds } from "./detached-groups";

import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import { DEFAULT_RELAYS, NDK_CONNECT_TIMEOUT_MS } from "../config/relays";
import { computeAllGroupRelays } from "../lib/relay-utils";

interface MarmotContextValue {
  client: MarmotClient | null;
  signer: EventSigner | null;
  groups: MarmotGroup[];
  pubkey: string;
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

      const groupStateKV = createKVStore<Uint8Array>("group-state");
      const groupStateBackend = new KeyValueGroupStateBackend(groupStateKV);

      const keyPackageKV = createKVStore<any>("key-packages");
      const keyPackageStore = new KeyPackageStore(keyPackageKV);

      const network = new NdkNetworkAdapter(ndk);

      const client = new MarmotClient({
        signer,
        groupStateBackend,
        keyPackageStore,
        network,
      });
      clientRef.current = client;

      if (!mountedRef.current) return;

      const groups = await client.loadAllGroups();

      if (!mountedRef.current) return;

      // Ensure NDK pool covers all per-group relays
      const allRelays = computeAllGroupRelays(groups, relays);
      for (const url of allRelays) {
        if (!ndk.pool.relays.has(url)) {
          ndk.pool.addRelay(new NDKRelay(url, undefined, ndk), true);
        }
      }

      // Make client available immediately — key package work runs in background
      setState({ client, groups, loading: false, error: null, discoverable: false });

      client.on("groupsUpdated", (updatedGroups) => {
        if (mountedRef.current) {
          // Add any new per-group relays to the NDK pool
          const updated = computeAllGroupRelays(updatedGroups, relays);
          for (const url of updated) {
            if (!ndk.pool.relays.has(url)) {
              ndk.pool.addRelay(new NDKRelay(url, undefined, ndk), true);
            }
          }
          setState((prev) => ({ ...prev, groups: updatedGroups }));
        }
      });

      // Rotate consumed key packages after joining a group
      client.on("groupJoined", async () => {
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
      clientRef.current?.removeAllListeners();
      clientRef.current = null;
      // NDK doesn't expose a clean pool.disconnect() — just drop the reference
      ndkRef.current = null;
    };
  }, [init]);

  useDeviceSync(state.client, pubkey, relays, signer);

  const detachedGroupIds = useMemo(
    () => computeDetachedGroupIds(state.groups, pubkey),
    [state.groups, pubkey],
  );

  const contextValue: MarmotContextValue = {
    ...state,
    signer,
    pubkey,
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

