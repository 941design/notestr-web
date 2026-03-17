import React from "react";
import { LogOut } from "lucide-react";
import { shortenPubkey, hexToNpub } from "@/lib/nostr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ConnectionStatusProps {
  pubkey: string | null;
  authMethod: "nip07" | "nip46" | null;
  onDisconnect: () => void;
}

export function ConnectionStatus({
  pubkey,
  authMethod,
  onDisconnect,
}: ConnectionStatusProps) {
  if (!pubkey) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="size-2 shrink-0 rounded-full bg-destructive shadow-[0_0_6px] shadow-destructive" />
        <span className="font-mono text-muted-foreground">Not connected</span>
      </div>
    );
  }

  const label = authMethod === "nip46" ? "bunker" : "NIP-07";

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="size-2 shrink-0 rounded-full bg-success shadow-[0_0_6px] shadow-success" />
      <span
        className="font-mono text-muted-foreground"
        title={hexToNpub(pubkey)}
      >
        {shortenPubkey(pubkey)}
      </span>
      <Badge variant="secondary" className="text-xs uppercase tracking-wide">
        {label}
      </Badge>
      <Button variant="outline" size="sm" onClick={onDisconnect}>
        <LogOut className="size-3.5" />
        Disconnect
      </Button>
    </div>
  );
}
