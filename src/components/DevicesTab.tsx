"use client";

/**
 * DevicesTab.tsx
 *
 * Devices tab inside the Settings modal.
 *
 * Data source: union of
 *   (a) client.keyPackages.list() — local IDB key packages (our own slot)
 *   (b) client.network.request(relays, keyPackageFilters([pubkey])) — relay-fetched
 *       kind-30443 events authored by the local pubkey
 *
 * This is explicitly NOT DeviceList.tsx's ratchet-tree-leaves data flow
 * (architecture.md exploration finding #7). The ratchet tree only shows
 * admitted leaves; this list shows all KPs visible on the relay.
 *
 * Boundary rules:
 *   - useMarmot() is the only way to access client/signer/relays/clientId/pubkey.
 *   - No direct NDK imports.
 *   - No imports from DeviceList.tsx.
 *   - forgetSelfDevice / forgetSiblingDevice are the only action calls.
 */

import { useEffect, useRef, useState } from "react";
import {
  keyPackageFilters,
  getKeyPackageIdentifier,
} from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";

import { useMarmot } from "@/marmot/client";
import { forgetSelfDevice, forgetSiblingDevice } from "@/marmot/forget-device";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeviceEntry = {
  /** Slot identifier (d-tag value of the kind-30443 event). */
  slot: string;
  /** Earliest published event's created_at, or 0 if unknown. */
  createdAt: number;
  /** True when this is the current device. */
  isLocal: boolean;
};

interface DevicesTabProps {
  onSignOut: () => void;
}

// ---------------------------------------------------------------------------
// Slot extraction helper (mirrors device-sync.ts keyPackageSlot)
//
// marmot-ts v0.5 has a runtime/type mismatch: the static type says
// `identifier` but the runtime emits `d`. We read both.
// ---------------------------------------------------------------------------

function extractSlot(kp: { identifier?: string } & Record<string, unknown>): string | undefined {
  if (typeof kp.identifier === "string" && kp.identifier.length > 0) {
    return kp.identifier;
  }
  const d = (kp as { d?: unknown }).d;
  if (typeof d === "string" && d.length > 0) {
    return d;
  }
  return undefined;
}

function formatDate(unixSecs: number): string {
  if (unixSecs === 0) return "unknown";
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function friendlyName(slot: string): string {
  return `device-${slot.slice(8, 14)}`;
}

// ---------------------------------------------------------------------------
// DevicesTab component
// ---------------------------------------------------------------------------

export function DevicesTab({ onSignOut }: DevicesTabProps) {
  const { client, signer, relays, clientId, pubkey } = useMarmot();

  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-slot operation state — only one forget can run at a time.
  const [inFlight, setInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Mount tracking: prevents setState calls after the component unmounts
  // (e.g. if the Settings modal is closed while a forget is in-flight).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Load devices: local KPs union relay-fetched KPs
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!client || !pubkey || !clientId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);

      try {
        // (a) Local key packages from IDB.
        const localKps = await client.keyPackages.list();

        // Build a map of slot → createdAt from local KPs.
        const slotMap = new Map<string, number>();

        for (const kp of localKps) {
          const slot = extractSlot(kp as Parameters<typeof extractSlot>[0]);
          if (!slot) continue;
          // Use the earliest published event's created_at as the "registered" time.
          const earliest = (kp.published ?? []).reduce(
            (min: number, ev: NostrEvent) =>
              ev.created_at < min ? ev.created_at : min,
            Infinity,
          );
          slotMap.set(slot, earliest === Infinity ? 0 : earliest);
        }

        // Always ensure our own clientId appears even if not yet in IDB
        // (e.g. client just initialised but not yet published).
        if (clientId && !slotMap.has(clientId)) {
          slotMap.set(clientId, 0);
        }

        // (b) Relay-fetched kind-30443 events authored by our pubkey.
        if (relays.length > 0) {
          try {
            const relayEvents = await client.network.request(
              relays,
              keyPackageFilters([pubkey]),
            );
            for (const event of relayEvents) {
              const slot = getKeyPackageIdentifier(event) ?? (event.tags.find((t) => t[0] === "d")?.[1]);
              if (!slot) continue;
              if (!slotMap.has(slot) || slotMap.get(slot) === 0) {
                slotMap.set(slot, event.created_at ?? 0);
              }
            }
          } catch {
            // Relay fetch failure is non-fatal — we still show local devices.
          }
        }

        if (cancelled) return;

        const entries: DeviceEntry[] = Array.from(slotMap.entries()).map(
          ([slot, createdAt]) => ({
            slot,
            createdAt,
            isLocal: slot === clientId,
          }),
        );

        // Sort: local device first, then by createdAt descending.
        entries.sort((a, b) => {
          if (a.isLocal && !b.isLocal) return -1;
          if (!a.isLocal && b.isLocal) return 1;
          return b.createdAt - a.createdAt;
        });

        setDevices(entries);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load devices.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [client, pubkey, clientId, relays]);

  // ---------------------------------------------------------------------------
  // Forget handlers
  // ---------------------------------------------------------------------------

  const handleForgetSelf = async () => {
    if (!client || !signer) return;
    setInFlight(true);
    setActionError(null);
    try {
      await forgetSelfDevice(client, signer, relays, onSignOut);
    } catch (err) {
      // Guard against unmount: modal may have closed while the await was in flight.
      if (mountedRef.current) {
        setActionError(err instanceof Error ? err.message : "Self-forget failed.");
        setInFlight(false);
      }
    }
    // If onSignOut was called, the component unmounts — no need to reset state.
  };

  const handleForgetSibling = async (slot: string) => {
    if (!client) return;
    setInFlight(true);
    setActionError(null);
    try {
      await forgetSiblingDevice(client, pubkey, slot);
      // Remove the forgotten device from the list.
      if (mountedRef.current) {
        setDevices((prev) => prev.filter((d) => d.slot !== slot));
      }
    } catch (err) {
      if (mountedRef.current) {
        setActionError(err instanceof Error ? err.message : "Forget device failed.");
      }
    } finally {
      if (mountedRef.current) {
        setInFlight(false);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Loading devices…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="py-6 text-center text-sm text-destructive">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {actionError && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {inFlight && (
        <div
          className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
          data-testid="device-progress"
        >
          <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Removing from groups…
        </div>
      )}

      {devices.length === 0 && (
        <div className="py-4 text-center text-sm text-muted-foreground">
          No devices found.
        </div>
      )}

      <ul className="space-y-3">
        {devices.map((device) => (
          <li
            key={device.slot}
            data-testid="device-row"
            className="flex flex-col gap-1 rounded-lg border bg-card p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {friendlyName(device.slot)}
                </span>
                {device.isLocal && (
                  <Badge variant="secondary" className="text-xs">
                    This device
                  </Badge>
                )}
              </div>

              {device.isLocal ? (
                <SelfForgetDialog
                  disabled={inFlight}
                  onConfirm={handleForgetSelf}
                />
              ) : (
                <SiblingForgetDialog
                  slot={device.slot}
                  disabled={inFlight}
                  onConfirm={() => handleForgetSibling(device.slot)}
                />
              )}
            </div>

            <div className="space-y-0.5 text-xs text-muted-foreground">
              <div className="truncate font-mono">{device.slot}</div>
              <div>Registered: {formatDate(device.createdAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-forget dialog
// ---------------------------------------------------------------------------

interface SelfForgetDialogProps {
  disabled: boolean;
  onConfirm: () => void;
}

function SelfForgetDialog({ disabled, onConfirm }: SelfForgetDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled}
          data-testid="device-forget-self-btn"
        >
          Forget
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Forget this device?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove this device from all your groups and sign you out.
            You will need to reconnect your key to access your groups again.
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={disabled}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="device-forget-self-confirm-btn"
          >
            Forget &amp; sign out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Sibling-forget dialog
// ---------------------------------------------------------------------------

interface SiblingForgetDialogProps {
  slot: string;
  disabled: boolean;
  onConfirm: () => void;
}

function SiblingForgetDialog({ slot, disabled, onConfirm }: SiblingForgetDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled}
          data-testid="device-forget-sibling-btn"
          aria-label={`Forget device ${slot.slice(0, 8)}`}
        >
          Forget
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Forget this device?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove this device from all groups where you are an admin.
            The device&apos;s key package on the relay will expire on its own in
            approximately 28 days — it is not deleted immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={disabled}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="device-forget-sibling-confirm-btn"
          >
            Forget device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
