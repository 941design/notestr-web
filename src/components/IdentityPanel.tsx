"use client";

/**
 * IdentityPanel.tsx
 *
 * Displays this device's identity for group messaging and observed sibling
 * device slots.
 *
 * Data sources:
 *   - useMarmot()  → client, pubkey, relays, groups, clientId
 *   - client.keyPackages.list() → local IDB KPs for current-slot event info
 *   - client.network.request(...) → relay-fetched kind-30443 for sibling slots
 *
 * Boundary rules (architecture.md):
 *   - Only consumes marmot state via useMarmot() (presentation layer rule).
 *   - groupHasKeyPackageLeaf from device-sync.ts is the sole cross-module
 *     runtime import (same pattern as DevicesTab importing forgetSelfDevice).
 *   - No direct IDB access. No toast library.
 */

import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { keyPackageFilters, getKeyPackageIdentifier } from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";

import { useMarmot } from "@/marmot/client";
import { groupHasKeyPackageLeaf } from "@/marmot/device-sync";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-relay event record for the current device's KP. */
type CurrentSlotEvent = {
  event_id: string;
  relays_where_published: string[];
  created_at: number;
};

/** A sibling device slot observed on the relay. */
type SiblingSlot = {
  d_slot: string;
  latest_event_id: string;
  latest_created_at: number;
  relays_seen_on: string[];
  is_in_group: boolean;
  /** The raw event, kept so is_in_group can be computed per group. */
  _event: NostrEvent;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}

function formatDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// IdentityPanel
// ---------------------------------------------------------------------------

export function IdentityPanel() {
  const { client, pubkey, relays, groups, clientId } = useMarmot();

  const [currentSlotEvents, setCurrentSlotEvents] = useState<CurrentSlotEvent[]>([]);
  const [siblingSlots, setSiblingSlots] = useState<SiblingSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Load: current-slot event info + sibling slots from relay
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!client || !pubkey || !clientId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);

      try {
        // (a) Local KPs — find the current device's published event info.
        const localKps = await client.keyPackages.list();

        // Find the local KP matching clientId (d-slot == clientId for addressable KPs).
        const selfKp = localKps.find((kp) => {
          const id = (kp as { identifier?: string; d?: string }).identifier
            ?? (kp as { d?: string }).d;
          return id === clientId;
        });

        const publishedEvents: CurrentSlotEvent[] = [];
        if (selfKp) {
          const published = (selfKp.published ?? []) as NostrEvent[];
          for (const ev of published) {
            const relayUrls = relays.length > 0 ? relays : [];
            publishedEvents.push({
              event_id: ev.id,
              relays_where_published: relayUrls,
              created_at: ev.created_at,
            });
          }
        }

        if (cancelled) return;
        if (mountedRef.current) setCurrentSlotEvents(publishedEvents);

        // (b) Relay-fetched kind-30443 events — find siblings.
        if (relays.length > 0) {
          try {
            const relayEvents = await client.network.request(
              relays,
              keyPackageFilters([pubkey]),
            );

            if (cancelled) return;

            // Build a map of d_slot → latest event for slots that are NOT ours.
            const siblingMap = new Map<string, NostrEvent>();

            for (const event of relayEvents) {
              const slot =
                getKeyPackageIdentifier(event) ??
                (event.tags.find((t) => t[0] === "d")?.[1]);
              if (!slot || slot === clientId) continue;

              const existing = siblingMap.get(slot);
              if (!existing || event.created_at > existing.created_at) {
                siblingMap.set(slot, event);
              }
            }

            const siblings: SiblingSlot[] = Array.from(siblingMap.entries()).map(
              ([d_slot, event]) => {
                const is_in_group = groups.some((group) =>
                  groupHasKeyPackageLeaf(group.state, event),
                );
                return {
                  d_slot,
                  latest_event_id: event.id,
                  latest_created_at: event.created_at,
                  relays_seen_on: relays,
                  is_in_group,
                  _event: event,
                };
              },
            );

            // Sort by latest_created_at descending.
            siblings.sort((a, b) => b.latest_created_at - a.latest_created_at);

            if (mountedRef.current) setSiblingSlots(siblings);
          } catch {
            // Relay fetch failure is non-fatal — show current-device info only.
          }
        }
      } catch (err) {
        if (mountedRef.current && !cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load identity data.",
          );
        }
      } finally {
        if (mountedRef.current && !cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // groups is intentionally included so is_in_group recomputes when group
    // membership changes during the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pubkey, clientId, relays, groups]);

  // ---------------------------------------------------------------------------
  // Guard: not signed in
  // ---------------------------------------------------------------------------

  if (!client || !pubkey) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Not signed in.
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {/* Explainer (AC-IDENT-3) */}
      <p className="text-sm text-muted-foreground">
        Each browser or device has its own unique identity for group messaging.
        Groups are joined per-device, so a group may appear on one device but
        not another. If a group is missing here, the person who added you may
        need to re-add your current device.
      </p>

      {loadError && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {/* Current device section (AC-IDENT-1) */}
      <section aria-labelledby="identity-current-heading">
        <h3
          id="identity-current-heading"
          className="mb-2 text-sm font-semibold"
        >
          This device
        </h3>

        <div className="space-y-2 rounded-lg border bg-card p-3">
          {/* clientId */}
          <div>
            <div className="mb-0.5 text-xs text-muted-foreground">
              Device identifier
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 break-all rounded-md bg-muted p-2 text-xs"
                data-testid="identity-client-id"
              >
                {clientId}
              </code>
              <CopyButton text={clientId} label="device identifier" />
            </div>
          </div>

          {/* KP d-slot */}
          <div>
            <div className="mb-0.5 text-xs text-muted-foreground">
              Key slot
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 break-all rounded-md bg-muted p-2 text-xs"
                data-testid="identity-kp-slot"
              >
                {clientId}
              </code>
              <CopyButton text={clientId} label="key slot" />
            </div>
          </div>

          {/* Per-event relay info */}
          {!loading && currentSlotEvents.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                Published key package
              </div>
              <ul className="space-y-1">
                {currentSlotEvents.map((ev) => (
                  <li
                    key={ev.event_id}
                    className="rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                    data-testid="identity-kp-event"
                  >
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="text-muted-foreground">Event:</span>
                      <span className="truncate font-mono">
                        {ev.event_id.slice(0, 16)}…
                      </span>
                    </div>
                    <div className="mb-0.5">
                      <span className="text-muted-foreground">Published:</span>{" "}
                      {formatDate(ev.created_at)}
                    </div>
                    {ev.relays_where_published.length > 0 && (
                      <div>
                        <span className="text-muted-foreground">Relays:</span>{" "}
                        {ev.relays_where_published.join(", ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {loading && (
            <div className="text-xs text-muted-foreground">
              Loading published events…
            </div>
          )}
        </div>
      </section>

      {/* Sibling slots section (AC-IDENT-2) */}
      <section aria-labelledby="identity-siblings-heading">
        <h3
          id="identity-siblings-heading"
          className="mb-2 text-sm font-semibold"
        >
          Other devices
        </h3>

        {loading ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            Loading other devices…
          </div>
        ) : siblingSlots.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            No other devices observed.
          </div>
        ) : (
          <ul className="space-y-2" data-testid="identity-sibling-list">
            {siblingSlots.map((sibling) => (
              <li
                key={sibling.d_slot}
                data-testid="identity-sibling-row"
                className="rounded-lg border bg-card p-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium font-mono">
                      {sibling.d_slot.slice(0, 16)}…
                    </span>
                  </div>
                  <Badge
                    variant={sibling.is_in_group ? "secondary" : "outline"}
                    className="text-xs"
                    data-testid="identity-sibling-group-badge"
                  >
                    {sibling.is_in_group ? "In a group" : "No shared group"}
                  </Badge>
                </div>

                <div className="space-y-0.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>Slot:</span>
                    <span className="flex items-center gap-1 font-mono">
                      <span className="truncate">{sibling.d_slot}</span>
                      <CopyButton text={sibling.d_slot} label="sibling slot" />
                    </span>
                  </div>
                  <div>
                    <span>Last seen:</span>{" "}
                    {formatDate(sibling.latest_created_at)}
                  </div>
                  <div className="truncate">
                    <span>Event:</span>{" "}
                    <span className="font-mono">
                      {sibling.latest_event_id.slice(0, 16)}…
                    </span>
                  </div>
                  {sibling.relays_seen_on.length > 0 && (
                    <div className="truncate">
                      <span>Seen on:</span>{" "}
                      {sibling.relays_seen_on.join(", ")}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
