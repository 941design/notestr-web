import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Check } from "lucide-react";
import { hexToNpub } from "@/lib/nostr";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DevicesTab } from "@/components/DevicesTab";
import { IdentityPanel } from "@/components/IdentityPanel";
import { PendingInvitations } from "@/components/PendingInvitations";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  pubkey: string;
  authMethod: "nip07" | "nip46" | null;
  onSignOut: () => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  pubkey,
  authMethod,
  onSignOut,
}: SettingsModalProps) {
  const [copied, setCopied] = useState(false);
  const npub = hexToNpub(pubkey);
  const label = authMethod === "nip46" ? "bunker" : "NIP-07";

  function handleCopy() {
    navigator.clipboard.writeText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="settings-modal">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Your account details and sharing options.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="connection">
          <TabsList className="w-full">
            <TabsTrigger value="connection" className="flex-1">
              Connection
            </TabsTrigger>
            <TabsTrigger value="devices" className="flex-1">
              Devices
            </TabsTrigger>
            <TabsTrigger value="identity" className="flex-1">
              Identity
            </TabsTrigger>
            <TabsTrigger value="pending-invitations" className="flex-1">
              Pending Invitations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection">
            <div className="space-y-4 pt-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Connection:</span>
                <Badge
                  variant="secondary"
                  className="text-xs uppercase tracking-wide"
                >
                  {label}
                </Badge>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Share your npub</div>
                <div className="flex items-center justify-center rounded-lg border bg-white p-4">
                  <QRCodeSVG
                    value={npub}
                    size={200}
                    level="M"
                    data-testid="settings-npub-qr"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 break-all rounded-md bg-muted p-2 text-xs"
                    data-testid="settings-npub-value"
                  >
                    {npub}
                  </code>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={handleCopy}
                    aria-label="Copy npub"
                  >
                    {copied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="devices">
            <div className="pt-2">
              <DevicesTab onSignOut={onSignOut} />
            </div>
          </TabsContent>

          <TabsContent value="identity">
            <div className="pt-2">
              <IdentityPanel />
            </div>
          </TabsContent>

          <TabsContent value="pending-invitations">
            <div className="pt-2">
              <PendingInvitations />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
