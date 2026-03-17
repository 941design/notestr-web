import React, { useState } from "react";
import { useMarmot } from "../marmot/client";
import { npubToHex } from "../lib/nostr";

interface GroupManagerProps {
  onGroupSelect: (groupId: string) => void;
  selectedGroupId: string | null;
}

export function GroupManager({
  onGroupSelect,
  selectedGroupId,
}: GroupManagerProps) {
  const { client, groups, loading } = useMarmot();
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
        relays: ["ws://localhost:7777"],
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
      // TODO: Fetch the invitee's key package event (kind 443) from relays
      // then call group.inviteByKeyPackageEvent(keyPackageEvent)
      // For now, just validate the npub
      setError(
        "Invite sent (key package fetch not yet implemented)"
      );
      setInviteNpub("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid npub or invite failed"
      );
    }
  }

  return (
    <div className="group-manager">
      <h2 className="sidebar-title">Groups</h2>

      {loading && <p className="text-muted">Loading groups...</p>}

      <ul className="group-list">
        {groups.map((group) => (
          <li
            key={group.idStr}
            className={`group-item ${selectedGroupId === group.idStr ? "active" : ""}`}
            onClick={() => onGroupSelect(group.idStr)}
          >
            <span className="group-name">
              {group.groupData?.name || "Unnamed Group"}
            </span>
          </li>
        ))}
        {!loading && groups.length === 0 && (
          <li className="group-item empty">No groups yet</li>
        )}
      </ul>

      <form className="sidebar-form" onSubmit={handleCreateGroup}>
        <h3 className="form-title">Create Group</h3>
        <input
          type="text"
          className="input"
          placeholder="Group name"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          disabled={creating}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={creating || !newGroupName.trim()}
        >
          {creating ? "Creating..." : "Create"}
        </button>
      </form>

      {selectedGroupId && (
        <form className="sidebar-form" onSubmit={handleInvite}>
          <h3 className="form-title">Invite Member</h3>
          <input
            type="text"
            className="input"
            placeholder="npub1..."
            value={inviteNpub}
            onChange={(e) => setInviteNpub(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!inviteNpub.trim()}
          >
            Invite
          </button>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
