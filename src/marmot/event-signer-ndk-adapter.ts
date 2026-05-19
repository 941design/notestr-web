import { NDKUser, type NDKSigner, type NostrEvent } from "@nostr-dev-kit/ndk";
import type { EventSigner } from "applesauce-core";

/**
 * Adapts an applesauce-core EventSigner to the NDKSigner interface so that
 * NDK's NIP-42 AUTH policy can use the application's existing signer.
 *
 * The pubkey is passed at construction time (already known from the provider
 * prop) rather than awaited from signer.getPublicKey(), which allows the
 * synchronous NDKSigner.pubkey getter to return without blocking.
 *
 * encrypt() and decrypt() are not needed by NDKAuthPolicies.signIn but must
 * be present to satisfy the interface — they throw explicitly so any future
 * caller gets a clear stack trace instead of a silent falsy return.
 */
export class EventSignerNdkAdapter implements NDKSigner {
  private readonly wrapped: EventSigner;
  private readonly _pubkey: string;
  private readonly _user: NDKUser;

  constructor(signer: EventSigner, pubkey: string) {
    this.wrapped = signer;
    this._pubkey = pubkey;
    this._user = new NDKUser({ pubkey });
  }

  get pubkey(): string {
    return this._pubkey;
  }

  get userSync(): NDKUser {
    return this._user;
  }

  async blockUntilReady(): Promise<NDKUser> {
    return this._user;
  }

  async user(): Promise<NDKUser> {
    return this._user;
  }

  async sign(event: NostrEvent): Promise<string> {
    // NDK's NostrEvent has kind typed as `number | undefined`; applesauce-core's
    // EventTemplate requires `number`. AUTH events always carry a kind, so the
    // cast is safe. We pass the event unmodified to preserve signed content integrity.
    const signed = await this.wrapped.signEvent(event as Parameters<EventSigner["signEvent"]>[0]);
    return signed.sig;
  }

  async encrypt(): Promise<string> {
    throw new Error("EventSignerNdkAdapter: encrypt not implemented");
  }

  async decrypt(): Promise<string> {
    throw new Error("EventSignerNdkAdapter: decrypt not implemented");
  }

  toPayload(): string {
    return JSON.stringify({ type: "EventSignerNdkAdapter", pubkey: this._pubkey });
  }
}
