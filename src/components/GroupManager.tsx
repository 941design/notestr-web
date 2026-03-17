import React, { useState } from "react";
import { Plus, UserPlus, Users } from "lucide-react";
import { useMarmot } from "@/marmot/client";
import { npubToHex } from "@/lib/nostr";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface GroupManagerProps {
  onGroupSelect: (groupId: string) => void;
  selectedGroupId: string | null;
}

export function GroupManager({
  onGroupSelect,
  selectedGroupId,
}: GroupManagerProps) {
  const { client, groups, relays, loading } = useMarmot();
  const [newGroupName, setNewGroupName] = useState("");
  const [inviteNpub, setInviteNpub] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      onGroupSelect(group.idStr);
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
    try {
      const _hex = npubToHex(inviteNpub.trim());
      setError("Invite sent (key package fetch not yet implemented)");
      setInviteNpub("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid npub or invite failed",
      );
    }
  }

  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Users className="size-3.5" />
        Groups
      </h2>

      {loading && (
        <p className="text-sm text-muted-foreground">Loading groups...</p>
      )}

      <ul className="mb-5 space-y-1">
        {groups.map((group) => (
          <li
            key={group.idStr}
            className={cn(
              "cursor-pointer rounded-sm px-3 py-2.5 text-sm transition-colors hover:bg-primary/[0.08]",
              selectedGroupId === group.idStr &&
                "bg-primary/[0.15] text-primary",
            )}
            onClick={() => onGroupSelect(group.idStr)}
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
          disabled={creating || !newGroupName.trim()}
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
          />
          <Button
            type="submit"
            className="w-full"
            disabled={!inviteNpub.trim()}
          >
            <UserPlus className="size-4" />
            Invite
          </Button>
        </form>
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
