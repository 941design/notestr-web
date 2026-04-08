import React, { useState, useEffect, useRef } from "react";
import { LogOut, Plus, UserPlus, Users, QrCode, ScanLine, X } from "lucide-react";
import { useMarmot } from "@/marmot/client";
import { npubToHex, shortenPubkey, hexToNpub } from "@/lib/nostr";
import { DeviceList } from "@/components/DeviceList";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  getGroupMembers,
  getNostrGroupIdHex,
  keyPackageFilters,
} from "@internet-privacy/marmot-ts";
import { NpubQrModal } from "@/components/NpubQrModal";
import { publishTaskSnapshot } from "@/marmot/device-sync";
import { clearEvents } from "@/store/persistence";
import { abbreviateRelay, isValidRelayUrl, getGroupRelays } from "@/lib/relay-utils";
import { DEFAULT_RELAYS } from "@/config/relays";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface GroupManagerProps {
  onGroupSelect: (groupId: string, groupName: string) => void;
  onGroupLeft?: () => void;
  selectedGroupId: string | null;
}

export function GroupManager({
  onGroupSelect,
  onGroupLeft,
  selectedGroupId,
}: GroupManagerProps) {
  const {
    client,
    signer,
    groups,
    relays,
    pubkey: selfPubkey,
    clientId,
    loading,
    error: marmotError,
    detachedGroupIds,
  } = useMarmot();
  const [newGroupName, setNewGroupName] = useState("");
  const [inviteNpub, setInviteNpub] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanQrOpen, setScanQrOpen] = useState(false);
  const [memberQr, setMemberQr] = useState<string | null>(null);
  const [pendingLeaveGroupId, setPendingLeaveGroupId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const profileCacheRef = useRef<Map<string, string>>(new Map());
  const [groupRelays, setGroupRelays] = useState<string[]>([...DEFAULT_RELAYS]);
  const [relayInput, setRelayInput] = useState("");
  const selectedGroup = selectedGroupId
    ? groups.find((group) => group.idStr === selectedGroupId)
    : undefined;

  useEffect(() => {
    if (!selectedGroupId || !client) {
      setMembers([]);
      return;
    }

    const group = groups.find((g) => g.idStr === selectedGroupId);
    if (!group?.state) {
      setMembers([]);
      return;
    }

    const hexPubkeys = getGroupMembers(group.state);
    setMembers(hexPubkeys);

    // Fetch profiles for members not yet in cache
    const uncached = hexPubkeys.filter(
      (hex) => !profileCacheRef.current.has(hex),
    );
    if (uncached.length === 0) {
      setProfileNames(new Map(profileCacheRef.current));
      return;
    }

    (async () => {
      try {
        const events = await client.network.request(relays, [
          { kinds: [0], authors: uncached, limit: uncached.length },
        ]);
        for (const event of events) {
          try {
            const content = JSON.parse(event.content as string);
            const name: string | undefined =
              (content.display_name || content.displayName) ||
              content.name;
            if (name && event.pubkey) {
              profileCacheRef.current.set(event.pubkey as string, name);
            }
          } catch {
            // skip malformed profile content
          }
        }
      } catch {
        // network error — fall back to shortened pubkeys
      }
      setProfileNames(new Map(profileCacheRef.current));
    })();
  }, [selectedGroupId, groups, client, relays]);

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!client || !newGroupName.trim()) return;

    setCreating(true);
    setError(null);
    try {
      const group = await client.createGroup(newGroupName.trim(), {
        relays: groupRelays.length > 0 ? groupRelays : relays,
      });
      setNewGroupName("");
      setGroupRelays([...DEFAULT_RELAYS]);
      setRelayInput("");
      onGroupSelect(group.idStr, newGroupName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
    } finally {
      setCreating(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!client || !selectedGroupId || !inviteNpub.trim()) return;

    setError(null);
    setInviting(true);
    try {
      const hex = npubToHex(inviteNpub.trim());
      const group = groups.find((g) => g.idStr === selectedGroupId);
      if (!group) throw new Error("Group not found");

      // Fetch the invitee's key package from relays.
      // Matches both legacy kind 443 and current addressable kind 30443.
      const keyPackageEvents = await client.network.request(
        relays,
        keyPackageFilters([hex]),
      );
      if (keyPackageEvents.length === 0) {
        throw new Error(
          "No key package found for this user. They may not have published one yet.",
        );
      }

      // Prefer the most recently published key package.
      const freshestKeyPackage = keyPackageEvents
        .slice()
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

      await group.inviteByKeyPackageEvent(freshestKeyPackage);

      // Publish NIP-44 encrypted task snapshot for the invitee.
      // MLS application messages from before the invite epoch are
      // undecryptable by the new member, so we send the current state
      // outside MLS as a standard encrypted Nostr event.
      if (client && signer) {
        const groupHTag = getNostrGroupIdHex(group.state);
        publishTaskSnapshot(
          selectedGroupId, groupHTag, hex, signer, client.network, relays,
        ).catch((err) => {
          console.debug("[GroupManager] snapshot publish failed:", err);
        });
      }

      setInviteNpub("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid npub or invite failed",
      );
    } finally {
      setInviting(false);
    }
  }

  async function confirmLeave() {
    if (!client || !pendingLeaveGroupId) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      const isDetachedGroup = detachedGroupIds.has(pendingLeaveGroupId);
      if (isDetachedGroup) {
        await client.destroyGroup(pendingLeaveGroupId);
      } else {
        await client.leaveGroup(pendingLeaveGroupId);
      }
      await clearEvents(pendingLeaveGroupId);
      setPendingLeaveGroupId(null);
      onGroupLeft?.();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "Failed to leave group");
    } finally {
      setLeaving(false);
    }
  }

  return (
    <nav aria-label="Groups">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Users className="size-3.5" />
        Groups
      </h2>

      {loading && (
        <p className="text-sm text-muted-foreground">Loading groups...</p>
      )}

      {marmotError && (
        <p className="mb-3 text-sm text-destructive">
          {marmotError.message}
        </p>
      )}

      <ul className="mb-5 space-y-1">
        {groups.map((group) => {
          const isDetached = detachedGroupIds.has(group.idStr);
          return (
            <li
              key={group.idStr}
              aria-current={selectedGroupId === group.idStr ? "true" : undefined}
              data-detached={isDetached ? "true" : undefined}
              className={cn(
                "touch-target rounded-sm px-3 py-2.5 text-sm transition-colors flex items-center gap-1",
                isDetached
                  ? "opacity-50"
                  : "hover:bg-primary/[0.08]",
                selectedGroupId === group.idStr &&
                  !isDetached &&
                  "bg-primary/[0.15] text-primary",
              )}
            >
              <span
                className={cn("block flex-1 min-w-0", !isDetached && "cursor-pointer")}
                onClick={() => {
                  if (!isDetached) {
                    onGroupSelect(group.idStr, group.groupData?.name || "Unnamed Group");
                  }
                }}
              >
                <span className="block truncate">
                  {group.groupData?.name || "Unnamed Group"}
                </span>
                <span
                  data-testid="group-relays"
                  className="block truncate text-[10px] text-muted-foreground/70"
                >
                  {getGroupRelays(group, DEFAULT_RELAYS).map(abbreviateRelay).join(", ")}
                </span>
                <span
                  data-testid="group-member-count"
                  className="text-[10px] text-muted-foreground/70"
                >
                  {group.state ? getGroupMembers(group.state).length : 0} {group.state && getGroupMembers(group.state).length === 1 ? "member" : "members"}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="group-leave-btn"
                aria-label="Leave group"
                onClick={(e) => {
                  e.stopPropagation();
                  setLeaveError(null);
                  setPendingLeaveGroupId(group.idStr);
                }}
              >
                <LogOut className="size-3" />
              </Button>
            </li>
          );
        })}
        {!loading && groups.length === 0 && (
          <li className="cursor-default px-3 py-2.5 text-sm italic text-muted-foreground">
            No groups yet
          </li>
        )}
      </ul>

      <form className="mb-4 space-y-2" onSubmit={handleCreateGroup}>
        <Label className="text-xs font-semibold text-muted-foreground">
          Create Group
        </Label>
        <Input
          placeholder="Group name"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          disabled={creating}
        />
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Relays</Label>
          <div className="flex flex-wrap gap-1">
            {groupRelays.map((relay) => (
              <span
                key={relay}
                data-testid="relay-chip"
                className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {abbreviateRelay(relay)}
                <button
                  type="button"
                  className="ml-0.5 rounded-full hover:text-foreground"
                  onClick={() => setGroupRelays((prev) => prev.filter((r) => r !== relay))}
                  aria-label={`Remove ${relay}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <Input
              data-testid="relay-input"
              placeholder="wss://relay.example.com"
              value={relayInput}
              onChange={(e) => setRelayInput(e.target.value)}
              disabled={creating}
              className="flex-1 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const url = relayInput.trim();
                  if (url && isValidRelayUrl(url) && !groupRelays.includes(url)) {
                    setGroupRelays((prev) => [...prev, url]);
                    setRelayInput("");
                  }
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="relay-add-btn"
              disabled={!relayInput.trim() || !isValidRelayUrl(relayInput.trim()) || groupRelays.includes(relayInput.trim())}
              onClick={() => {
                const url = relayInput.trim();
                if (url && isValidRelayUrl(url) && !groupRelays.includes(url)) {
                  setGroupRelays((prev) => [...prev, url]);
                  setRelayInput("");
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={loading || creating || !newGroupName.trim()}
        >
          <Plus className="size-4" />
          {creating ? "Creating..." : "Create"}
        </Button>
      </form>

      {selectedGroupId && !detachedGroupIds.has(selectedGroupId) && (() => {
        const selectedRelays = selectedGroup ? getGroupRelays(selectedGroup, DEFAULT_RELAYS) : DEFAULT_RELAYS;
        return (
          <section data-testid="group-relay-list" className="mb-4">
            <Label className="mb-2 block text-xs font-semibold text-muted-foreground">
              Relays
            </Label>
            <ul className="space-y-0.5">
              {selectedRelays.map((relay) => (
                <li key={relay} className="truncate px-3 py-0.5 text-xs font-mono text-muted-foreground">
                  {abbreviateRelay(relay)}
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      {selectedGroupId && members.length > 0 && (
        <section data-testid="members-section" className="mb-4">
          <Label className="mb-2 block text-xs font-semibold text-muted-foreground">
            Members
          </Label>
          <ul className="space-y-1">
            {members.map((hex) => (
              <li
                key={hex}
                data-testid="member-item"
                className="touch-target truncate px-3 py-1.5 text-sm font-mono text-muted-foreground flex items-center gap-1"
                title={hexToNpub(hex)}
              >
                <span className="flex-1 truncate">
                  {profileNames.get(hex) ?? shortenPubkey(hex)}
                  {hex === selfPubkey && " (you)"}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setMemberQr(hex)}
                  aria-label="Show QR code"
                  data-testid={`member-show-qr-${hex.slice(0, 8)}`}
                >
                  <QrCode className="size-3" />
                </Button>
              </li>
            ))}
          </ul>

          <NpubQrModal
            isOpen={memberQr !== null}
            onClose={() => setMemberQr(null)}
            title={memberQr ? (profileNames.get(memberQr) ?? shortenPubkey(memberQr)) : ""}
            mode="display"
            npub={memberQr ? hexToNpub(memberQr) : undefined}
          />
        </section>
      )}

      {selectedGroup && !detachedGroupIds.has(selectedGroup.idStr) && client && clientId && (
        <DeviceList
          client={client}
          group={selectedGroup}
          pubkey={selfPubkey}
          localClientId={clientId}
          relays={relays}
        />
      )}

      {selectedGroupId && !detachedGroupIds.has(selectedGroupId) && (
        <form className="mb-4 space-y-2" onSubmit={handleInvite}>
          <Label className="text-xs font-semibold text-muted-foreground">
            Invite Member
          </Label>
          <div className="flex gap-1.5">
            <Input
              placeholder="npub1..."
              value={inviteNpub}
              onChange={(e) => setInviteNpub(e.target.value)}
              disabled={inviting}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setScanQrOpen(true)}
              aria-label="Scan QR code"
              data-testid="invite-scan-qr-btn"
            >
              <ScanLine className="size-4" />
            </Button>
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={!inviteNpub.trim() || inviting}
          >
            <UserPlus className="size-4" />
            {inviting ? "Inviting..." : "Invite"}
          </Button>
          <NpubQrModal
            isOpen={scanQrOpen}
            onClose={() => setScanQrOpen(false)}
            title="Scan npub QR"
            mode="scan"
            onScan={(scannedNpub) => {
              setInviteNpub(scannedNpub);
              setError(null);
              setScanQrOpen(false);
            }}
          />
        </form>
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}

      {leaveError && (
        <p className="mt-2 text-sm text-destructive">{leaveError}</p>
      )}

      <AlertDialog
        open={pendingLeaveGroupId !== null}
        onOpenChange={(open) => { if (!open && !leaving) { setLeaveError(null); setPendingLeaveGroupId(null); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this group?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to all its tasks.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="group-leave-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmLeave}
              disabled={leaving}
            >
              {leaving ? "Leaving..." : "Leave"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
