import type { EventSigner } from "applesauce-core";
import { decode, npubEncode } from "nostr-tools/nip19";

// NIP-07 window.nostr interface
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: any): Promise<any>;
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>;
        decrypt(pubkey: string, ciphertext: string): Promise<string>;
      };
      nip44?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>;
        decrypt(pubkey: string, ciphertext: string): Promise<string>;
      };
    };
  }
}

export function getNip07Signer(): EventSigner | null {
  if (!window.nostr) return null;
  return window.nostr as unknown as EventSigner;
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
