import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import { defaultProposalTypes } from "ts-mls";

export async function removeLeafByIndex(
  group: MarmotGroup,
  leafIndex: number,
): Promise<void> {
  await group.commit({
    extraProposals: [
      {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: leafIndex },
      },
    ],
  });
}
