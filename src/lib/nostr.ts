import type { EventSigner } from "applesauce-core";
import { decode, npubEncode } from "nostr-tools/nip19";
import NDK, { NDKNip46Signer, NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools/pure";
import { NDK_CONNECT_TIMEOUT_MS } from "@/config/relays";

const NIP46_LOCAL_KEY = "notestr-nip46-local-key";
const NIP46_PAYLOAD = "notestr-nip46-payload";
const AUTH_METHOD_KEY = "notestr-auth-method";

/**
 * Exhaustive comma-separated NIP-46 perms string passed to NDKNip46Signer.
 * Exported so the perms-audit unit test can import it directly without mocking NDK.
 *
 * Kinds covered:
 *   5      – NIP-09 deletion (stale KP cleanup in client.tsx, forget-device.ts,
 *            and marmot-ts key-package-manager rotate/purge)
 *   13     – NIP-59 Seal (applesauce-common gift-wrap pipeline, called when
 *            marmot-ts sends MLS welcome invitations)
 *   10051  – Relay list (client.tsx)
 *   22242  – NIP-42 AUTH (NDK-internal; EventSignerNdkAdapter routes AUTH
 *            challenges through the app signer)
 *   30443  – Addressable key package (marmot-ts key-package-manager publish/rotate)
 */
export const NIP46_PERMS =
  "sign_event:5,sign_event:13,sign_event:10051,sign_event:22242,sign_event:30443,nip44_encrypt,nip44_decrypt";

export function getNip07Signer(): EventSigner | null {
  if (!window.nostr) return null;
  return window.nostr as unknown as EventSigner;
}

export function setSavedAuthMethod(method: "nip07" | "nip46" | null): void {
  if (method) {
    localStorage.setItem(AUTH_METHOD_KEY, method);
    return;
  }

  localStorage.removeItem(AUTH_METHOD_KEY);
}

export function getSavedAuthMethod(): "nip07" | "nip46" | null {
  const value = localStorage.getItem(AUTH_METHOD_KEY);
  return value === "nip07" || value === "nip46" ? value : null;
}

/**
 * Bridge NDKNip46Signer to EventSigner interface expected by marmot-ts.
 * NDKNip46Signer.sign() returns just the signature string, but
 * EventSigner.signEvent() must return a full signed NostrEvent.
 */
function bridgeNip46ToEventSigner(nip46: NDKNip46Signer): EventSigner {
  return {
    getPublicKey: () => nip46.getPublicKey(),
    signEvent: async (draft: any) => {
      const pubkey = await nip46.getPublicKey();
      const event = {
        ...draft,
        pubkey,
        id: "",
        sig: "",
      };
      event.sig = await nip46.sign(event);
      event.id = getEventHash(event);
      return event;
    },
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) => {
        const user = new NDKUser({ pubkey });
        return nip46.encrypt(user, plaintext, "nip44");
      },
      decrypt: async (pubkey: string, ciphertext: string) => {
        const user = new NDKUser({ pubkey });
        return nip46.decrypt(user, ciphertext, "nip44");
      },
    },
    nip04: {
      encrypt: async (pubkey: string, plaintext: string) => {
        const user = new NDKUser({ pubkey });
        return nip46.encrypt(user, plaintext, "nip04");
      },
      decrypt: async (pubkey: string, ciphertext: string) => {
        const user = new NDKUser({ pubkey });
        return nip46.decrypt(user, ciphertext, "nip04");
      },
    },
  };
}

export interface Nip46Connection {
  signer: EventSigner;
  pubkey: string;
  nip46Signer: NDKNip46Signer;
}

/**
 * Connect to a NIP-46 remote signer via bunker:// URL.
 * Persists the session so it can be restored without re-authorization.
 */
export async function connectBunker(
  bunkerUrl: string,
  relays: string[],
): Promise<Nip46Connection> {
  const ndk = new NDK({ explicitRelayUrls: relays });
  await ndk.connect(NDK_CONNECT_TIMEOUT_MS);

  // Restore local key if we have one, for session continuity
  const savedKey = localStorage.getItem(NIP46_LOCAL_KEY) ?? undefined;
  const nip46 = NDKNip46Signer.bunker(ndk, bunkerUrl, savedKey);

  await nip46.blockUntilReady();

  // Persist session
  localStorage.setItem(NIP46_LOCAL_KEY, nip46.localSigner.privateKey!);
  localStorage.setItem(NIP46_PAYLOAD, nip46.toPayload());
  setSavedAuthMethod("nip46");

  const pubkey = await nip46.getPublicKey();
  return {
    signer: bridgeNip46ToEventSigner(nip46),
    pubkey,
    nip46Signer: nip46,
  };
}

/**
 * Try to restore a previously saved NIP-46 session.
 */
export async function restoreNip46Session(
  relays: string[],
): Promise<Nip46Connection | null> {
  const payload = localStorage.getItem(NIP46_PAYLOAD);
  if (!payload) return null;

  try {
    const ndk = new NDK({ explicitRelayUrls: relays });
    await ndk.connect(NDK_CONNECT_TIMEOUT_MS);

    const nip46 = await NDKNip46Signer.fromPayload(payload, ndk);
    await nip46.blockUntilReady();

    // Re-persist in case payload changed
    localStorage.setItem(NIP46_PAYLOAD, nip46.toPayload());
    setSavedAuthMethod("nip46");

    const pubkey = await nip46.getPublicKey();
    return {
      signer: bridgeNip46ToEventSigner(nip46),
      pubkey,
      nip46Signer: nip46,
    };
  } catch (err) {
    console.warn("Failed to restore NIP-46 session:", err);
    clearNip46Session();
    return null;
  }
}

export function clearNip46Session(): void {
  localStorage.removeItem(NIP46_LOCAL_KEY);
  localStorage.removeItem(NIP46_PAYLOAD);
  if (getSavedAuthMethod() === "nip46") {
    setSavedAuthMethod(null);
  }
}

export function hasNip46Session(): boolean {
  return !!localStorage.getItem(NIP46_PAYLOAD);
}

/**
 * Start a nostrconnect:// flow (app-initiated, for Amber and QR-capable signers).
 * Returns the URI immediately for display as a QR code / deep link,
 * plus a promise that resolves once the signer connects.
 */
export function startNostrConnect(
  relay: string,
  relays: string[],
): { uri: string; connection: Promise<Nip46Connection>; cancel: () => void } {
  const ndk = new NDK({ explicitRelayUrls: relays });
  const savedKey = localStorage.getItem(NIP46_LOCAL_KEY) ?? undefined;
  const signer = NDKNip46Signer.nostrconnect(ndk, relay, savedKey, {
    name: "notestr",
    perms: NIP46_PERMS,
  });
  const uri = signer.nostrConnectUri!;

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const connection = (async (): Promise<Nip46Connection> => {
    await ndk.connect(NDK_CONNECT_TIMEOUT_MS);
    await signer.blockUntilReady();
    if (cancelled) throw new Error("Cancelled");

    localStorage.setItem(NIP46_LOCAL_KEY, signer.localSigner.privateKey!);
    localStorage.setItem(NIP46_PAYLOAD, signer.toPayload());
    setSavedAuthMethod("nip46");

    const pubkey = await signer.getPublicKey();
    return {
      signer: bridgeNip46ToEventSigner(signer),
      pubkey,
      nip46Signer: signer,
    };
  })();

  return { uri, connection, cancel };
}

export function npubToHex(npub: string): string {
  const { type, data } = decode(npub);
  if (type !== "npub") throw new Error(`Expected npub, got ${type}`);
  return data as string;
}

export function hexToNpub(hex: string): string {
  return npubEncode(hex);
}

export function shortenPubkey(pubkey: string): string {
  return pubkey.slice(0, 8) + "..." + pubkey.slice(-4);
}
