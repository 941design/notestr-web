import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import NDK from "@nostr-dev-kit/ndk";
import {
  MarmotClient,
  KeyValueGroupStateBackend,
  KeyPackageStore,
} from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";

import { createKVStore } from "./storage";
import { NdkNetworkAdapter } from "./network";

import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import { DEFAULT_RELAYS, NDK_CONNECT_TIMEOUT_MS } from "../config/relays";

interface MarmotContextValue {
  client: MarmotClient | null;
  groups: MarmotGroup[];
  pubkey: string;
  relays: string[];
  loading: boolean;
  error: Error | null;
}

const MarmotContext = createContext<MarmotContextValue>({
  client: null,
  groups: [],
  pubkey: "",
  relays: DEFAULT_RELAYS,
  loading: true,
  error: null,
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
    Pick<MarmotContextValue, "client" | "groups" | "loading" | "error">
  >({
    client: null,
    groups: [],
    loading: true,
    error: null,
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

      setState({ client, groups, loading: false, error: null });

      client.on("groupsUpdated", (updatedGroups) => {
        if (mountedRef.current) {
          setState((prev) => ({ ...prev, groups: updatedGroups }));
        }
      });

      // Publish initial key package if none exist
      const existingPackages = await client.keyPackages.list();
      if (existingPackages.length === 0 && relays.length > 0) {
        await client.keyPackages.create({ relays });
      }
    } catch (err) {
      if (mountedRef.current) {
        setState({
          client: null,
          groups: [],
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
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

  const contextValue: MarmotContextValue = {
    ...state,
    pubkey,
    relays,
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
