import React from "react";
import type { EventSigner } from "applesauce-core";
import { shortenPubkey, hexToNpub } from "../lib/nostr";

interface ConnectionStatusProps {
  signer: EventSigner | null;
  pubkey: string | null;
  onConnect: () => void;
}

export function ConnectionStatus({
  signer,
  pubkey,
  onConnect,
}: ConnectionStatusProps) {
  if (!signer) {
    return (
      <div className="connection-status disconnected">
        <span className="status-dot red" />
        <span className="status-text">No NIP-07 extension detected</span>
      </div>
    );
  }

  if (!pubkey) {
    return (
      <div className="connection-status">
        <span className="status-dot yellow" />
        <span className="status-text">Extension found</span>
        <button className="btn btn-primary btn-sm" onClick={onConnect}>
          Connect
        </button>
      </div>
    );
  }

  return (
    <div className="connection-status connected">
      <span className="status-dot green" />
      <span className="status-text" title={hexToNpub(pubkey)}>
        {shortenPubkey(pubkey)}
      </span>
    </div>
  );
}
