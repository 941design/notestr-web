import React from "react";
import { LogOut } from "lucide-react";
import { shortenPubkey, hexToNpub } from "@/lib/nostr";
import { Button } from "@/components/ui/button";
import { useMarmot } from "@/marmot/client";

interface ConnectionStatusProps {
  pubkey: string | null;
  onDisconnect: () => void;
}

export function ConnectionStatus({
  pubkey,
  onDisconnect,
}: ConnectionStatusProps) {
  const { discoverable } = useMarmot();

  if (!pubkey) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="size-2 shrink-0 rounded-full bg-destructive shadow-[0_0_6px] shadow-destructive" />
        <span className="font-mono text-muted-foreground">Not connected</span>
      </div>
    );
  }

  const npub = hexToNpub(pubkey);
  const dotColor = discoverable ? "bg-success shadow-success" : "bg-warning shadow-warning";
  const dotTitle = discoverable
    ? "Discoverable — others can invite you to groups"
    : "Not discoverable — no published key package available for invites";

  return (
    <div className="flex items-center gap-2 text-sm" data-testid="pubkey-chip">
      <span
        className={`size-2 shrink-0 rounded-full shadow-[0_0_6px] ${dotColor}`}
        title={dotTitle}
      />
      <span
        className="font-mono text-muted-foreground"
        title={npub}
      >
        {shortenPubkey(pubkey)}
      </span>
      <Button variant="outline" size="sm" onClick={onDisconnect} data-testid="disconnect-button">
        <LogOut className="size-3.5" />
        Disconnect
      </Button>
    </div>
  );
}
