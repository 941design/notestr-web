import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";

import type { Task, TaskEvent } from "@/store/task-events";

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
  }
}

export {};
