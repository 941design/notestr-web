import { describe, expect, it, vi } from "vitest";
import { defaultProposalTypes } from "ts-mls";

import { removeLeafByIndex } from "./per-leaf-remove";

describe("removeLeafByIndex", () => {
  it("commits a single remove proposal for the requested leaf", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);

    await removeLeafByIndex({ commit } as any, 7);

    expect(commit).toHaveBeenCalledWith({
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: 7 },
        },
      ],
    });
  });
});
