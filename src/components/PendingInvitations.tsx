"use client";

/**
 * PendingInvitations.tsx
 *
 * Lists FailedWelcomeRecord entries from the IDB failed-welcomes store and
 * provides per-record recovery instructions and a dismiss action.
 *
 * Boundary rules (architecture.md):
 *   - Data consumed exclusively via useMarmot() and @/marmot/failed-welcomes.
 *   - No direct NDK imports.
 *   - No toast library — inline DOM patterns only (DevicesTab.tsx pattern).
 *   - "use client" directive required (Next.js app-router convention).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useMarmot } from "@/marmot/client";
import {
  loadFailedWelcomes,
  forgetFailedWelcome,
  type FailedWelcomeRecord,
} from "@/marmot/failed-welcomes";
import {
  inviterShort,
  failureReasonLabel,
  recoveryInstruction,
} from "@/components/pending-invitations-helpers";

import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// PendingInvitations component
// ---------------------------------------------------------------------------

export function PendingInvitations() {
  const { client, clientId, pubkey } = useMarmot();

  const [records, setRecords] = useState<FailedWelcomeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-record dismiss in-flight state (keyed by giftWrapEventId).
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const [dismissError, setDismissError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await loadFailedWelcomes();
      if (mountedRef.current) {
        setRecords(result);
      }
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(
          err instanceof Error ? err.message : "Failed to load pending invitations.",
        );
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Initial load (guard: only when signed in)
  useEffect(() => {
    if (!client || !pubkey) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await loadFailedWelcomes();
        if (!cancelled && mountedRef.current) {
          setRecords(result);
        }
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load pending invitations.",
          );
        }
      } finally {
        if (!cancelled && mountedRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, pubkey]);

  // Refresh on DOM event
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener("notestr:failed-welcomes-changed", handler);
    return () => window.removeEventListener("notestr:failed-welcomes-changed", handler);
  }, [load]);

  // ---------------------------------------------------------------------------
  // Dismiss
  // ---------------------------------------------------------------------------

  const handleDismiss = async (record: FailedWelcomeRecord) => {
    const id = record.giftWrapEventId;
    setDismissing((prev) => new Set(prev).add(id));
    setDismissError(null);

    try {
      // For decrypt_failed records: markAsRead was NOT called at failure time
      // (the event failed to decrypt before reaching InviteManager). We must
      // call it here so the relay-side invite is consumed and won't be re-processed.
      //
      // For all other records (join-failure): markAsRead was already called
      // during failure handling — do NOT call it again (double-mark).
      if (record.failureReason === "decrypt_failed" && client) {
        await client.invites.markAsRead(id);
      }

      await forgetFailedWelcome(id);

      if (mountedRef.current) {
        setRecords((prev) => prev.filter((r) => r.giftWrapEventId !== id));
      }
    } catch (err) {
      if (mountedRef.current) {
        setDismissError(
          err instanceof Error ? err.message : "Failed to dismiss invitation.",
        );
      }
    } finally {
      if (mountedRef.current) {
        setDismissing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Guard: not signed in
  // ---------------------------------------------------------------------------

  if (!client || !pubkey) {
    return (
      <div
        className="py-6 text-center text-sm text-muted-foreground"
        data-testid="pending-invitations-not-signed-in"
      >
        Not signed in.
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div
        className="py-6 text-center text-sm text-muted-foreground"
        data-testid="pending-invitations-loading"
      >
        Loading pending invitations…
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="py-6 text-center text-sm text-destructive"
        data-testid="pending-invitations-error"
      >
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="pending-invitations-panel">
      {dismissError && (
        <div
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="pending-invitations-dismiss-error"
        >
          {dismissError}
        </div>
      )}

      {records.length === 0 ? (
        <div
          className="py-6 text-center text-sm text-muted-foreground"
          data-testid="pending-invitations-empty"
        >
          No pending invitations
        </div>
      ) : (
        <ul className="space-y-3" data-testid="pending-invitations-list">
          {records.map((record) => {
            const isDismissing = dismissing.has(record.giftWrapEventId);
            const groupLabel = record.groupId
              ? `group ${record.groupId.slice(0, 8)}`
              : null;
            const inviterLabel = inviterShort(record.inviterPubkey);
            const ariaLabel =
              groupLabel
                ? `Dismiss invitation to ${groupLabel} from ${inviterLabel}`
                : `Dismiss invitation from ${inviterLabel}`;

            return (
              <li
                key={record.giftWrapEventId}
                data-testid="pending-invitation-row"
                className="flex flex-col gap-2 rounded-lg border bg-card p-3"
              >
                {/* Header row: inviter + group */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">From:</span>{" "}
                      <span
                        className="font-mono"
                        data-testid="pending-invitation-inviter"
                      >
                        {inviterLabel}
                      </span>
                    </div>

                    {record.groupId && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Group:</span>{" "}
                        <span
                          className="font-mono"
                          data-testid="pending-invitation-group"
                        >
                          {record.groupId.slice(0, 16)}…
                        </span>
                      </div>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDismissing}
                    onClick={() => void handleDismiss(record)}
                    aria-label={ariaLabel}
                    data-testid="pending-invitation-dismiss-btn"
                  >
                    {isDismissing ? "Dismissing…" : "Dismiss"}
                  </Button>
                </div>

                {/* Failure reason + recovery instruction */}
                <div className="space-y-1 rounded-md bg-muted/50 px-2.5 py-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    {failureReasonLabel(record.failureReason)}
                  </div>
                  <p
                    className="text-xs text-foreground"
                    data-testid="pending-invitation-recovery"
                  >
                    {recoveryInstruction(record, clientId)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
