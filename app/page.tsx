"use client";

import React, { useState, useEffect, useCallback } from "react";
import { QrCode, Key, Link as LinkIcon, Loader2, Menu, X, Users, ChevronRight, Settings as SettingsIcon } from "lucide-react";
import {
  getNip07Signer,
  connectBunker,
  restoreNip46Session,
  clearNip46Session,
  hasNip46Session,
  startNostrConnect,
  getSavedAuthMethod,
  setSavedAuthMethod,
} from "@/lib/nostr";
import { QRCodeSVG } from "qrcode.react";
import { MarmotProvider, useMarmot } from "@/marmot/client";
import { TaskStoreProvider } from "@/store/task-store";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { SettingsModal } from "@/components/SettingsModal";
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

const LAST_GROUP_KEY = "notestr:lastGroup";

function saveLastGroup(id: string, name: string) {
  try { localStorage.setItem(LAST_GROUP_KEY, JSON.stringify({ id, name })); } catch {}
}
function loadLastGroup(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem(LAST_GROUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string") return parsed;
  } catch {}
  return null;
}
function clearLastGroup() {
  try { localStorage.removeItem(LAST_GROUP_KEY); } catch {}
}

function DetachedBoard({ groupId, pubkey }: { groupId: string; pubkey: string }) {
  const { detachedGroupIds } = useMarmot();
  const isDetached = detachedGroupIds.has(groupId);
  return <Board currentUserPubkey={pubkey} isDetached={isDetached} />;
}

export default function Page() {
  const [signer, setSigner] = useState<EventSigner | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(() => loadLastGroup()?.id ?? null);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(() => loadLastGroup()?.name ?? null);
  const [signerChecked, setSignerChecked] = useState(false);
  const [connectingTooSlow, setConnectingTooSlow] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);
  const [isAndroid, setIsAndroid] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

    // Show spinner only after 300ms to avoid flash on fast loads
    const spinnerTimer = setTimeout(() => {
      if (!cancelled) setShowSpinner(true);
    }, 300);

    // Show "taking longer than expected" message after 5 seconds
    const slowTimer = setTimeout(() => {
      if (!cancelled) setConnectingTooSlow(true);
    }, 5000);

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

      const s = getNip07Signer();
      const savedAuthMethod = getSavedAuthMethod();

      if (s && savedAuthMethod === "nip07") {
        try {
          const pk = await s.getPublicKey();
          if (!cancelled) {
            setSigner(s);
            setPubkey(pk);
            setAuthMethod("nip07");
            setSignerChecked(true);
            return;
          }
        } catch {
          setSavedAuthMethod(null);
        }
      }

      await new Promise((r) => setTimeout(r, 300));
      if (!cancelled) {
        if (s) setSigner(s);
        setSignerChecked(true);
      }
    }

    init();
    return () => {
      cancelled = true;
      clearTimeout(spinnerTimer);
      clearTimeout(slowTimer);
    };
  }, []);

  useEffect(() => {
    setIsAndroid(/Android/i.test(window.navigator.userAgent));
  }, []);

  const handleNip07Connect = useCallback(async () => {
    const s = getNip07Signer();
    if (!s) return;
    setSigner(s);
    try {
      const pk = await s.getPublicKey();
      setPubkey(pk);
      setAuthMethod("nip07");
      setSavedAuthMethod("nip07");
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
    if (authMethod === "nip07") {
      setSavedAuthMethod(null);
    }
    setSigner(null);
    setPubkey(null);
    setAuthMethod(null);
    setSelectedGroupId(null);
    setSelectedGroupName(null);
  }, [authMethod]);

  // Not yet connected: show connect screen
  if (!pubkey) {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between border-b bg-card px-6 py-3" style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}>
          <h1 className="text-xl font-bold tracking-tight text-primary">
            notestr
          </h1>
          <ThemeToggle />
        </header>
        <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6" style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))" }}>
          {!signerChecked ? (
            showSpinner ? (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Checking for saved session...</span>
                </div>
                {connectingTooSlow && (
                  <div className="flex flex-col items-center gap-2 text-center">
                    <p className="text-sm text-muted-foreground">
                      Taking longer than expected.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        clearNip46Session();
                        setSavedAuthMethod(null);
                        setSignerChecked(true);
                        setConnectingTooSlow(false);
                        setShowSpinner(false);
                      }}
                    >
                      Skip and sign in manually
                    </Button>
                  </div>
                )}
              </div>
            ) : null
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
                    <LinkIcon className="size-4" />
                    Remote Signer
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="amber">
                    <TabsList variant="line" className="w-full">
                      <TabsTrigger value="amber" className="touch-target">
                        <QrCode className="size-3.5" />
                        Amber / QR Code
                      </TabsTrigger>
                      <TabsTrigger value="bunker" className="touch-target">
                        <LinkIcon className="size-3.5" />
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
                          {isAndroid && (
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
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between border-b bg-card px-4 py-3 md:px-6" style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}>
          {/* Hamburger — visible only on mobile */}
          <button
            className="mr-2 flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            {drawerOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <h1 className="shrink-0 text-xl font-bold tracking-tight text-primary">
              notestr
            </h1>
            {selectedGroupName && (
              <>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate text-sm font-medium text-foreground">
                  {selectedGroupName}
                </span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon className="size-5" />
            </button>
            <ConnectionStatus
              pubkey={pubkey}
              onDisconnect={handleDisconnect}
            />
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* Mobile drawer backdrop — absolute so the page header stays uncovered */}
          {drawerOpen && (
            <div
              className="absolute inset-0 z-20 bg-black/50 md:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* Sidebar — desktop: static 280px; tablet: icon rail 56px; mobile: overlay drawer below header */}
          <aside
            className={[
              // Base: positioned within the content row so the header remains visible above
              "absolute inset-y-0 left-0 z-30 flex flex-col overflow-y-auto overscroll-contain border-r bg-card transition-transform duration-200",
              // Mobile: full-width drawer up to ~280px
              "w-[280px]",
              // Mobile open/closed
              drawerOpen ? "translate-x-0" : "-translate-x-full",
              // Tablet+: always visible as static element
              "md:static md:translate-x-0 md:w-14 md:shrink-0",
              // Desktop: full sidebar
              "lg:w-[280px]",
            ].join(" ")}
          >
            {/* Tablet icon rail — shown only at md breakpoint */}
            <div className="hidden md:flex lg:hidden flex-col items-center gap-3 py-4">
              {/* Rail is just a visual placeholder; clicking it will expand via overlay */}
              <button
                className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                aria-label="Expand sidebar"
                onClick={() => setDrawerOpen(true)}
              >
                <Menu className="size-5" />
              </button>
            </div>

            {/* Full sidebar content — shown on mobile drawer and desktop */}
            <div className="flex-1 overflow-y-auto p-4 md:hidden lg:block">
              <GroupManager
                onGroupSelect={(id, name) => {
                  setSelectedGroupId(id);
                  setSelectedGroupName(name);
                  saveLastGroup(id, name);
                  setDrawerOpen(false);
                }}
                onGroupLeft={() => { setSelectedGroupId(null); setSelectedGroupName(null); clearLastGroup(); }}
                selectedGroupId={selectedGroupId}
              />
            </div>
          </aside>

          {/* Tablet expanded sidebar overlay */}
          {drawerOpen && (
            <div className="hidden md:block lg:hidden">
              <div
                className="absolute inset-0 z-20 bg-black/50"
                onClick={() => setDrawerOpen(false)}
                aria-hidden="true"
              />
              <aside className="absolute inset-y-0 left-0 z-30 w-[280px] overflow-y-auto border-r bg-card p-4">
                <GroupManager
                  onGroupSelect={(id, name) => {
                    setSelectedGroupId(id);
                    setSelectedGroupName(name);
                    saveLastGroup(id, name);
                    setDrawerOpen(false);
                  }}
                  selectedGroupId={selectedGroupId}
                />
              </aside>
            </div>
          )}

          <main className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}>
            {selectedGroupId ? (
              <TaskStoreProvider groupId={selectedGroupId}>
                <DetachedBoard groupId={selectedGroupId} pubkey={pubkey} />
              </TaskStoreProvider>
            ) : (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-4 text-center">
                <Users className="size-12 text-muted-foreground/50" aria-hidden="true" />
                <div>
                  <h2 className="mb-1 text-xl font-semibold text-foreground">
                    No group selected
                  </h2>
                  <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                    Select a group from the sidebar or create a new one to start
                    managing tasks.
                  </p>
                </div>
                <Button
                  onClick={() => setDrawerOpen(true)}
                  className="md:hidden"
                >
                  Create your first group
                </Button>
                <p className="hidden text-sm text-muted-foreground md:block">
                  Use the sidebar to select or create a group.
                </p>
              </div>
            )}
          </main>
        </div>

        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          pubkey={pubkey}
          authMethod={authMethod}
        />
      </div>
    </MarmotProvider>
  );
}
