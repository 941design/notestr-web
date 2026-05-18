import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";

import type { Task, TaskEvent } from "@/store/task-events";
import type { TraceEvent } from "@/marmot/mls-trace";

declare global {
  interface Window {
    __notestrTestGroups?: () => Array<{
      idStr: string;
      nostrGroupIdHex: string;
      relays: string[];
    }>;
    __notestrTestPubkey?: () => string;
    __notestrTestInspectGroupEvent?: (
      groupId: string,
      eventId: string,
    ) => Promise<{
      event: NostrEvent | null;
      firstIngest: Array<{
        kind: string;
        reason?: string;
        errorMessages?: string[];
      }>;
      secondIngest: Array<{
        kind: string;
        reason?: string;
        errorMessages?: string[];
      }>;
      rumor: Rumor | null;
      currentEpoch?: string;
    }>;
    __notestrTestSentRumors?: (groupId: string) => Rumor[];
    __notestrTestResetSentRumors?: (groupId: string) => void;
    __notestrTestDispatchTaskEvent?: (taskEvent: TaskEvent) => Promise<void>;
    __notestrTestTasks?: () => Task[];
    __notestrTestPersistedTaskEvents?: () => Promise<TaskEvent[]>;
    __notestrTestArmPublishFailure?: (message?: string) => void;
    __notestrTestPublishFailureOnce?: string | null;
    /** Diagnostic hook: issue an unfiltered relay request via the mounted MarmotClient's network adapter. */
    __notestrTestNetworkRequest?: (
      relays: string[],
      filters: unknown[],
    ) => Promise<NostrEvent[]>;
    /**
     * Test-only: commit a per-leaf Remove proposal for the given leaf index in
     * the loaded group. Lets specs exercise forget-device semantics without
     * relying on the local-only DeviceList UI (which can only forget leaves
     * belonging to the current identity's pubkey).
     */
    __notestrTestForgetLeaf?: (groupId: string, leafIndex: number) => Promise<void>;
    /** Test-only: list MLS leaf indexes belonging to the given pubkey in the loaded group. */
    __notestrTestPubkeyLeafIndexes?: (groupId: string, pubkeyHex: string) => number[];
    /** Test-only: read the MLS epoch (coerced from bigint via Number()) for the group with the given idStr. Returns null if absent. */
    __notestrTestGroupEpoch?: (groupIdStr: string) => number | null;
    /** Test-only: read the sorted member pubkey set for a group. Returns null if absent. */
    __notestrTestGroupMembers?: (groupIdStr: string) => string[] | null;
    /** Test-only: count leaves belonging to a pubkey in a group. Returns 0 for unknown pubkey/group. */
    __notestrTestPubkeyLeafCount?: (groupIdStr: string, pubkeyHex: string) => number;
    /**
     * Test-only: dump the MLS receive-pipeline trace buffer.
     *
     * Installed by `MarmotProvider` only when both `isTestRuntime()` and
     * `process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1"` are true at build
     * time. Returns a defensive snapshot (per `MlsTrace.dump`'s contract:
     * each entry is JSON-cloned, so consumer mutation cannot corrupt the
     * recorder's internal buffer). Used by S3's diagnostic harness to
     * classify F1/F2/F3 failures from the failing-cluster e2e tests.
     */
    __notestrTestMlsTrace?: () => readonly TraceEvent[];
    /**
     * Test-only: inject a synthetic sibling KeyPackage event into the
     * auto-invite scan as if it had been discovered on the relay.
     *
     * Installed by `MarmotProvider` when `isTestRuntime()` is true.
     * Calls `group.inviteByKeyPackageEvent(siblingKpEvent)` on every
     * loaded group where the current user is admin and the key package
     * is not already a leaf — the same path the live auto-invite scan
     * takes. Used by S7's F2 regression test to force the commit+
     * app-message race condition (welcome commit at epoch N+1 racing
     * A's task application message on B's subscription).
     *
     * The injected event does NOT need to be signed or decrypt-able —
     * the hook exercises the auto-invite commit pathway, not MLS
     * decryption. `siblingKpEvent.pubkey` must match the current user's
     * pubkey so the invite flows to A's own groups (same as a real
     * sibling device scenario). Deleted on MarmotProvider unmount.
     */
    __notestrTestArmAutoInvite?: (siblingKpEvent: NostrEvent) => Promise<void>;
    /**
     * Test-only: return the current set of forgotten slot strings from the
     * notestr-forgotten-slots IDB store as a plain string[].
     *
     * Installed by MarmotProvider when NEXT_PUBLIC_E2E === "1". Returns an
     * empty array (never null/undefined) when the store is empty. Used by
     * S7's sibling-forget e2e spec to assert a slot was marked forgotten.
     */
    __notestrTestForgottenSlots?: () => Promise<string[]>;
  }
}

export {};
