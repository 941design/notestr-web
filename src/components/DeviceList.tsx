import { useEffect, useState } from "react";

import {
  getKeyPackage,
  getKeyPackageD,
  getPubkeyLeafNodeIndexes,
  getPubkeyLeafNodes,
  keyPackageFilters,
  type MarmotClient,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts";
import { defaultKeyPackageEqualityConfig, getOwnLeafNode } from "ts-mls";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  defaultDeviceName,
  getDeviceName,
  markDeviceSeen,
  setDeviceName,
} from "@/marmot/device-store";
import { removeLeafByIndex } from "@/marmot/per-leaf-remove";

type DeviceRow = {
  clientId: string;
  /**
   * Stable identifier for persisted device names: derived from the leaf's
   * signature key so it survives key-package rotations (which change the
   * relay event but not the in-tree leaf material).
   */
  storageKey: string;
  leafIndex: number | null;
  isLocal: boolean;
  name: string;
};

interface DeviceListProps {
  client: MarmotClient;
  group: MarmotGroup;
  pubkey: string;
  localClientId: string;
  relays: string[];
}

function toShortHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}

export function DeviceList({
  client,
  group,
  pubkey,
  localClientId,
  relays,
}: DeviceListProps) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [removingClientId, setRemovingClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadDevices = async () => {
      setLoading(true);

      try {
        const leaves = getPubkeyLeafNodes(group.state, pubkey);
        const leafIndexes = getPubkeyLeafNodeIndexes(group.state, pubkey);
        const keyPackageEvents = await client.network.request(
          group.relays ?? relays,
          keyPackageFilters([pubkey]),
        );

        // Identify our own leaf via the MLS state's own-leaf-node helper.
        // After a key-package rotation, the in-tree leaf no longer matches
        // any current local KeyPackage event (the relay's addressable
        // event has been replaced), so signature-key matching from the
        // store would mis-classify the local leaf as remote and lead to
        // forbidden self-removes when the user tries to forget another
        // device.
        const ownLeaf = (() => {
          try {
            return getOwnLeafNode(group.state);
          } catch {
            return undefined;
          }
        })();
        const ownSignatureKey = ownLeaf?.signaturePublicKey;
        const isOwnLeaf = (leaf: typeof leaves[number]): boolean => {
          if (!ownSignatureKey) return false;
          if (leaf.signaturePublicKey.length !== ownSignatureKey.length) return false;
          for (let i = 0; i < ownSignatureKey.length; i++) {
            if (leaf.signaturePublicKey[i] !== ownSignatureKey[i]) return false;
          }
          return true;
        };

        const nextDevices = await Promise.all(
          leaves.map(async (leaf, index): Promise<DeviceRow> => {
            const matchingEvent = keyPackageEvents.find((event) =>
              defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode(
                getKeyPackage(event),
                leaf,
              ),
            );
            const clientId =
              (matchingEvent ? getKeyPackageD(matchingEvent) : undefined) ??
              `leaf-${toShortHex(leaf.signaturePublicKey)}`;

            // Persistent storage key: derived from the leaf's signature
            // key so renames survive key-package rotations and reloads
            // (the relay event id and `d` slot may stop matching the
            // leaf material after a rotation, but the leaf signature
            // key only changes via an explicit Update commit).
            const storageKey = `leafkey-${toShortHex(leaf.signaturePublicKey)}-${leaf.signaturePublicKey.length}`;

            await markDeviceSeen(storageKey, {
              localClientId,
              fallbackName: defaultDeviceName(clientId, localClientId),
            });

            return {
              clientId,
              storageKey,
              leafIndex: leafIndexes[index] ?? null,
              isLocal: isOwnLeaf(leaf) || clientId === localClientId,
              name: await getDeviceName(storageKey, localClientId),
            };
          }),
        );

        if (cancelled) return;

        setDevices(nextDevices);
        setDraftNames(
          Object.fromEntries(
            nextDevices.map((device) => [device.storageKey, device.name]),
          ),
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadDevices();

    return () => {
      cancelled = true;
    };
  }, [client, group, group.state, localClientId, pubkey, relays]);

  const saveName = async (storageKey: string) => {
    const nextName = draftNames[storageKey] ?? "";
    await setDeviceName(storageKey, nextName);
    const resolved = await getDeviceName(storageKey, localClientId);
    setDevices((current) =>
      current.map((device) =>
        device.storageKey === storageKey ? { ...device, name: resolved } : device,
      ),
    );
    setDraftNames((current) => ({ ...current, [storageKey]: resolved }));
  };

  const forgetDevice = async (device: DeviceRow) => {
    if (device.isLocal || device.leafIndex === null) return;

    setRemovingClientId(device.storageKey);
    try {
      await removeLeafByIndex(group, device.leafIndex);
    } finally {
      setRemovingClientId(null);
    }
  };

  return (
    <section aria-label="Your devices" data-testid="device-list" className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">Your devices</h3>
        {loading && (
          <span className="text-[11px] text-muted-foreground">Loading...</span>
        )}
      </div>

      <ul className="space-y-2">
        {devices.map((device) => (
          <li
            key={device.clientId}
            data-testid="device-row"
            data-local={device.isLocal ? "true" : "false"}
            className="rounded-md border border-border/60 px-3 py-2"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="flex-1 truncate text-sm">{device.name}</span>
              {device.isLocal && (
                <Badge variant="secondary">this device</Badge>
              )}
            </div>

            <p className="mb-2 text-[11px] text-muted-foreground">
              slot: {device.clientId}
            </p>

            <div className="flex gap-2">
              <Input
                value={draftNames[device.storageKey] ?? device.name}
                onChange={(event) =>
                  setDraftNames((current) => ({
                    ...current,
                    [device.storageKey]: event.target.value,
                  }))
                }
                onBlur={() => {
                  void saveName(device.storageKey);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveName(device.storageKey);
                  }
                }}
                aria-label={`Device name for ${device.clientId}`}
                className="h-8 text-xs"
              />
              {!device.isLocal && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void forgetDevice(device);
                  }}
                  disabled={removingClientId === device.storageKey}
                >
                  {removingClientId === device.storageKey ? "Forgetting..." : "Forget"}
                </Button>
              )}
            </div>
          </li>
        ))}

        {!loading && devices.length === 0 && (
          <li className="px-3 py-2 text-sm italic text-muted-foreground">
            No devices found for this group.
          </li>
        )}
      </ul>
    </section>
  );
}
