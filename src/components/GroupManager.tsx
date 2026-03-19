import React, { useState, useEffect, useRef } from "react";
import { Plus, UserPlus, Users } from "lucide-react";
import { useMarmot } from "@/marmot/client";
import { npubToHex, shortenPubkey, hexToNpub } from "@/lib/nostr";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { getGroupMembers } from "@internet-privacy/marmot-ts";

interface GroupManagerProps {
  onGroupSelect: (groupId: string, groupName: string) => void;
  selectedGroupId: string | null;
}

export function GroupManager({
  onGroupSelect,
  selectedGroupId,
}: GroupManagerProps) {
  const { client, groups, relays, pubkey: selfPubkey, loading, error: marmotError } = useMarmot();
  const [newGroupName, setNewGroupName] = useState("");
  const [inviteNpub, setInviteNpub] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const profileCacheRef = useRef<Map<string, string>>(new Map());

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
        relays,
      });
      setNewGroupName("");
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

      // Fetch the invitee's key package (kind 443) from relays
      const keyPackageEvents = await client.network.request(relays, [
        { kinds: [443], authors: [hex], limit: 1 },
      ]);
      if (keyPackageEvents.length === 0) {
        throw new Error(
          "No key package found for this user. They may not have published one yet.",
        );
      }

      await group.inviteByKeyPackageEvent(keyPackageEvents[0]);
      setInviteNpub("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid npub or invite failed",
      );
    } finally {
      setInviting(false);
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
        {groups.map((group) => (
          <li
            key={group.idStr}
            aria-current={selectedGroupId === group.idStr ? "true" : undefined}
            className={cn(
              "touch-target cursor-pointer rounded-sm px-3 py-2.5 text-sm transition-colors hover:bg-primary/[0.08] flex items-center",
              selectedGroupId === group.idStr &&
                "bg-primary/[0.15] text-primary",
            )}
            onClick={() => onGroupSelect(group.idStr, group.groupData?.name || "Unnamed Group")}
          >
            <span className="block truncate">
              {group.groupData?.name || "Unnamed Group"}
            </span>
          </li>
        ))}
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
        <Button
          type="submit"
          className="w-full"
          disabled={loading || creating || !newGroupName.trim()}
        >
          <Plus className="size-4" />
          {creating ? "Creating..." : "Create"}
        </Button>
      </form>

      {selectedGroupId && (
        <form className="mb-4 space-y-2" onSubmit={handleInvite}>
          <Label className="text-xs font-semibold text-muted-foreground">
            Invite Member
          </Label>
          <Input
            placeholder="npub1..."
            value={inviteNpub}
            onChange={(e) => setInviteNpub(e.target.value)}
            disabled={inviting}
          />
          <Button
            type="submit"
            className="w-full"
            disabled={!inviteNpub.trim() || inviting}
          >
            <UserPlus className="size-4" />
            {inviting ? "Inviting..." : "Invite"}
          </Button>
        </form>
      )}

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
                className="touch-target truncate px-3 py-1.5 text-sm font-mono text-muted-foreground flex items-center"
                title={hexToNpub(hex)}
              >
                {profileNames.get(hex) ?? shortenPubkey(hex)}
                {hex === selfPubkey && " (you)"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}
    </nav>
  );
}
