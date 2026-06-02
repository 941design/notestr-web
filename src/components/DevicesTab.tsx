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

import { useMarmot } from "@/marmot/client";
import { forgetSelfDevice, forgetSiblingDevice } from "@/marmot/forget-device";
import {
  loadDevices,
  type DeviceEntry,
  type DeviceLoaderClient,
} from "@/components/DevicesTab.loadDevices";

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

interface DevicesTabProps {
  onSignOut: () => void;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

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
  // Non-fatal relay-fetch failure: local devices still render, but the list
  // may be incomplete, so we surface a visible warning.
  const [relayFetchError, setRelayFetchError] = useState<string | null>(null);

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
      setRelayFetchError(null);

      try {
        const { entries, relayFetchError: relayFailed } = await loadDevices(
          client as unknown as DeviceLoaderClient,
          pubkey,
          clientId,
          relays,
        );

        if (cancelled) return;

        setDevices(entries);
        if (relayFailed) {
          setRelayFetchError(
            "Could not reach relay — device list may be incomplete.",
          );
        }
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

      {relayFetchError && (
        <div
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="device-relay-error"
        >
          {relayFetchError}
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
