"use client";

import React, { useState, useEffect, useCallback } from "react";
import { QrCode, Key, Link, Loader2 } from "lucide-react";
import {
  getNip07Signer,
  connectBunker,
  restoreNip46Session,
  clearNip46Session,
  hasNip46Session,
  startNostrConnect,
} from "@/lib/nostr";
import { QRCodeSVG } from "qrcode.react";
import { MarmotProvider } from "@/marmot/client";
import { TaskStoreProvider } from "@/store/task-store";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GroupManager } from "@/components/GroupManager";
import { Board } from "@/components/Board";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { EventSigner } from "applesauce-core";
import { DEFAULT_RELAYS, NOSTRCONNECT_RELAY } from "@/config/relays";

type AuthMethod = "nip07" | "nip46" | null;

export default function Page() {
  const [signer, setSigner] = useState<EventSigner | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [signerChecked, setSignerChecked] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);

  // Bunker login state
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [bunkerConnecting, setBunkerConnecting] = useState(false);
  const [bunkerError, setBunkerError] = useState<string | null>(null);

  // Nostrconnect (Amber) state
  const [nostrConnectUri, setNostrConnectUri] = useState<string | null>(null);
  const [nostrConnectCancel, setNostrConnectCancel] = useState<
    (() => void) | null
  >(null);
  const [nostrConnectError, setNostrConnectError] = useState<string | null>(
    null,
  );

  // On mount: try restoring NIP-46 session, then check NIP-07
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (hasNip46Session()) {
        try {
          const conn = await restoreNip46Session(DEFAULT_RELAYS);
          if (conn && !cancelled) {
            setSigner(conn.signer);
            setPubkey(conn.pubkey);
            setAuthMethod("nip46");
            setSignerChecked(true);
            return;
          }
        } catch {
          // fall through to NIP-07
        }
      }

      await new Promise((r) => setTimeout(r, 300));
      if (!cancelled) {
        const s = getNip07Signer();
        if (s) setSigner(s);
        setSignerChecked(true);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleNip07Connect = useCallback(async () => {
    const s = getNip07Signer();
    if (!s) return;
    setSigner(s);
    setAuthMethod("nip07");
    try {
      const pk = await s.getPublicKey();
      setPubkey(pk);
    } catch (err) {
      console.error("Failed to get public key:", err);
    }
  }, []);

  const handleBunkerConnect = useCallback(async () => {
    if (!bunkerUrl.trim()) return;
    setBunkerConnecting(true);
    setBunkerError(null);
    try {
      const conn = await connectBunker(bunkerUrl.trim(), DEFAULT_RELAYS);
      setSigner(conn.signer);
      setPubkey(conn.pubkey);
      setAuthMethod("nip46");
      setBunkerUrl("");
    } catch (err) {
      setBunkerError(
        err instanceof Error ? err.message : "Failed to connect to bunker",
      );
    } finally {
      setBunkerConnecting(false);
    }
  }, [bunkerUrl]);

  const handleNostrConnect = useCallback(() => {
    setNostrConnectError(null);
    const { uri, connection, cancel } = startNostrConnect(
      NOSTRCONNECT_RELAY,
      [...DEFAULT_RELAYS, NOSTRCONNECT_RELAY],
    );
    setNostrConnectUri(uri);
    setNostrConnectCancel(() => cancel);

    connection
      .then((conn) => {
        setSigner(conn.signer);
        setPubkey(conn.pubkey);
        setAuthMethod("nip46");
        setNostrConnectUri(null);
        setNostrConnectCancel(null);
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "Cancelled") return;
        setNostrConnectError(
          err instanceof Error ? err.message : "Connection failed",
        );
        setNostrConnectUri(null);
        setNostrConnectCancel(null);
      });
  }, []);

  const handleNostrConnectCancel = useCallback(() => {
    nostrConnectCancel?.();
    setNostrConnectUri(null);
    setNostrConnectCancel(null);
    setNostrConnectError(null);
  }, [nostrConnectCancel]);

  const handleDisconnect = useCallback(() => {
    if (authMethod === "nip46") {
      clearNip46Session();
    }
    setSigner(null);
    setPubkey(null);
    setAuthMethod(null);
    setSelectedGroupId(null);
  }, [authMethod]);

  // Not yet connected: show connect screen
  if (!pubkey) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between border-b bg-card px-6 py-3">
          <h1 className="text-xl font-bold tracking-tight text-primary">
            notestr
          </h1>
          <ThemeToggle />
        </header>
        <main className="flex flex-1 items-center justify-center overflow-y-auto p-6">
          {!signerChecked ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Connecting...
            </div>
          ) : (
            <div className="w-full max-w-md space-y-3 text-left">
              <div className="text-center">
                <h2 className="text-xl font-semibold">Sign in to notestr</h2>
                <p className="text-sm text-muted-foreground">
                  Choose how to connect your Nostr identity
                </p>
              </div>

              {/* NIP-07 option */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Key className="size-4" />
                    Browser Extension
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {signer ? (
                    <Button className="w-full" onClick={handleNip07Connect}>
                      Connect with NIP-07
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No NIP-07 extension detected (nos2x, Alby, etc.)
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* NIP-46 remote signer options */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Link className="size-4" />
                    Remote Signer
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="amber">
                    <TabsList variant="line" className="w-full">
                      <TabsTrigger value="amber">
                        <QrCode className="size-3.5" />
                        Amber / QR Code
                      </TabsTrigger>
                      <TabsTrigger value="bunker">
                        <Link className="size-3.5" />
                        bunker:// URL
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="amber" className="pt-3">
                      {!nostrConnectUri ? (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            Scan a QR code with Amber or another NIP-46 signer
                          </p>
                          <Button
                            className="w-full"
                            onClick={handleNostrConnect}
                          >
                            <QrCode className="size-4" />
                            Show QR Code
                          </Button>
                          {nostrConnectError && (
                            <p className="text-sm text-destructive">
                              {nostrConnectError}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 py-2">
                          <QRCodeSVG
                            value={nostrConnectUri}
                            size={200}
                            bgColor="transparent"
                            fgColor="currentColor"
                            className="rounded-lg"
                          />
                          {/Android/i.test(
                            typeof navigator !== "undefined"
                              ? navigator.userAgent
                              : "",
                          ) && (
                            <Button className="w-full" asChild>
                              <a href={nostrConnectUri}>Open in Amber</a>
                            </Button>
                          )}
                          <p className="animate-pulse text-sm text-muted-foreground">
                            Waiting for signer to connect...
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleNostrConnectCancel}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="bunker" className="pt-3">
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Paste a bunker:// URL from nsec.app or another NIP-46
                          signer
                        </p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="bunker://..."
                            value={bunkerUrl}
                            onChange={(e) => setBunkerUrl(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && handleBunkerConnect()
                            }
                            disabled={bunkerConnecting}
                            className="flex-1"
                          />
                          <Button
                            onClick={handleBunkerConnect}
                            disabled={bunkerConnecting || !bunkerUrl.trim()}
                          >
                            {bunkerConnecting ? (
                              <>
                                <Loader2 className="size-4 animate-spin" />
                                Connecting
                              </>
                            ) : (
                              "Connect"
                            )}
                          </Button>
                        </div>
                        {bunkerError && (
                          <p className="text-sm text-destructive">
                            {bunkerError}
                          </p>
                        )}
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          )}
        </main>
      </div>
    );
  }

  // Connected: wrap in MarmotProvider
  return (
    <MarmotProvider signer={signer!} pubkey={pubkey}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between border-b bg-card px-6 py-3">
          <h1 className="text-xl font-bold tracking-tight text-primary">
            notestr
          </h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <ConnectionStatus
              pubkey={pubkey}
              authMethod={authMethod}
              onDisconnect={handleDisconnect}
            />
          </div>
        </header>
        <div className="flex flex-1 overflow-hidden">
          <aside className="w-[280px] shrink-0 overflow-y-auto border-r bg-card p-4">
            <GroupManager
              onGroupSelect={setSelectedGroupId}
              selectedGroupId={selectedGroupId}
            />
          </aside>
          <main className="flex-1 overflow-y-auto p-6">
            {selectedGroupId ? (
              <TaskStoreProvider groupId={selectedGroupId}>
                <Board currentUserPubkey={pubkey} />
              </TaskStoreProvider>
            ) : (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-muted-foreground">
                <h2 className="mb-2 text-xl font-semibold text-foreground">
                  Select a Group
                </h2>
                <p className="max-w-sm text-sm leading-relaxed">
                  Pick a group from the sidebar or create a new one to start
                  managing tasks.
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
    </MarmotProvider>
  );
}
