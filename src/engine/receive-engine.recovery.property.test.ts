/**
 * receive-engine.recovery.property.test.ts
 *
 * AC-REC-5 (R-INV-1) property test: a fact's recovery disposition (does R3
 * resubmit it for ingest, or not) depends ONLY on its `seq` versus
 * `checkpoint.lastIngestedSeq` and store membership -- NEVER on comparing
 * content-hash `id` values. `fast-check` generates `RawProtocolFact` ids as
 * random hex strings deliberately UNORDERED relative to `seq` (i.e. the
 * lexical/generation order of the id strings has no relationship to the
 * seq each is assigned to), and the property asserts that reshuffling
 * WHICH id string is assigned to which `seq` (holding `seq` and store
 * membership fixed) never changes the set of `seq`s resubmitted.
 *
 * Same AC-BOUND-1 boundary constraint as receive-engine.recovery.test.ts
 * (this file's module doc comment) applies here: the mock `PersistenceAdapter`
 * replicates the real store algorithm rather than importing it.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { createReceiveEngine, createRealEngineScheduler } from "./receive-engine";
import type {
  AcceptedDomainEvent,
  EngineCheckpoint,
  IngestSignal,
  IngestSource,
  NostrEvent,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
} from "./engine-types";

const GROUP_ID = "group-1";

function nostrEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: "pk-1",
    created_at: 1_700_000_000,
    kind: 445,
    tags: [],
    content: "ciphertext",
    sig: "sig",
  };
}

function factInput(id: string): RawProtocolFactInput {
  return {
    id,
    groupId: GROUP_ID,
    nostrEventId: id,
    nostrEvent: nostrEvent(id),
    receivedAt: 1_700_000_000_000,
    receiptSource: "historical",
    epochAtReceipt: "epoch-0",
  };
}

/** Minimal in-memory PersistenceAdapter + IngestSource pair sufficient to
 *  drive one restart-recovery pass and observe R3's ingestPersisted call. */
function createHarness() {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint>();
  const deferredIds = new Map<string, string[]>();
  const ingestPersistedCalls: RawProtocolFact[][] = [];

  const persistence: PersistenceAdapter = {
    async appendFact(fact) {
      const list = facts.get(fact.groupId) ?? [];
      const found = list.find((f) => f.id === fact.id);
      if (found) return { fact: found, duplicate: true };
      const seq = list.length === 0 ? 1 : list[list.length - 1].seq + 1;
      const newFact: RawProtocolFact = { ...fact, seq };
      facts.set(fact.groupId, [...list, newFact]);
      return { fact: newFact, duplicate: false };
    },
    async loadFacts(groupId) {
      return [...(facts.get(groupId) ?? [])].sort((a, b) => a.seq - b.seq);
    },
    async appendAcceptedEvent(event) {
      const list = acceptedEvents.get(event.groupId) ?? [];
      if (list.some((e) => e.id === event.id)) return;
      acceptedEvents.set(event.groupId, [...list, event]);
    },
    async loadAcceptedEvents(groupId) {
      return [...(acceptedEvents.get(groupId) ?? [])];
    },
    async saveCheckpoint(checkpoint) {
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    async loadCheckpoint(groupId) {
      return checkpoints.get(groupId) ?? null;
    },
    async saveDeferredIds(groupId, ids) {
      deferredIds.set(groupId, [...ids]);
    },
    async loadDeferredIds(groupId) {
      return [...(deferredIds.get(groupId) ?? [])];
    },
    async acceptDeferredFact(groupId, factId, event) {
      const list = acceptedEvents.get(groupId) ?? [];
      if (!list.some((e) => e.id === event.id)) {
        acceptedEvents.set(groupId, [...list, event]);
      }
      const ids = deferredIds.get(groupId) ?? [];
      deferredIds.set(groupId, ids.filter((id) => id !== factId));
    },
    async clearGroupState(groupId) {
      facts.delete(groupId);
      acceptedEvents.delete(groupId);
      checkpoints.delete(groupId);
      deferredIds.delete(groupId);
    },
  };

  async function* emptyDrain(): AsyncGenerator<IngestSignal> {}

  const adapter: IngestSource = {
    catchUp: () => emptyDrain(),
    openLive: () => () => {},
    ingestPersisted: (submitted) => {
      ingestPersistedCalls.push(submitted);
      return emptyDrain();
    },
    fetchBootstrap: () => emptyDrain(),
    close: () => {},
  };

  return {
    seedFactsAndCheckpoint(rawFacts: RawProtocolFact[], lastIngestedSeq: number) {
      facts.set(GROUP_ID, [...rawFacts]);
      checkpoints.set(GROUP_ID, {
        groupId: GROUP_ID,
        savedAt: 1,
        engineState: "live",
        lastEpoch: "epoch-0",
        lastIngestedSeq,
        lastAcceptedDomainEventId: null,
        bootstrapCompleted: true,
      });
    },
    persistence,
    adapter,
    ingestPersistedCalls,
  };
}

/**
 * Builds a rawLog of `ids.length` facts (seq 1..N, `ids[i]` as the fact id
 * for seq i+1), runs one restart-recovery pass with `lastIngestedSeq =
 * watermark`, and returns the sorted set of `seq`s R3 actually submitted
 * via `adapter.ingestPersisted`.
 */
async function recoverAndCollectResubmittedSeqs(
  ids: string[],
  watermark: number,
): Promise<number[]> {
  const harness = createHarness();
  const rawFacts: RawProtocolFact[] = ids.map((id, i) => ({
    ...factInput(id),
    seq: i + 1,
  }));
  harness.seedFactsAndCheckpoint(rawFacts, watermark);

  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: harness.adapter,
    persistence: harness.persistence,
    scheduler: createRealEngineScheduler(),
  });

  await engine.start({ origin: "restored" });
  await engine.stop();

  const submittedSeqs = harness.ingestPersistedCalls
    .flatMap((batch) => batch.map((f) => f.seq))
    .sort((a, b) => a - b);
  return submittedSeqs;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** N distinct hex-string ids, deliberately generated with NO relationship
 *  to seq order (fast-check's own shrinking/generation order is unrelated
 *  to numeric/lexical order of the strings). */
const idPoolArb = (n: number) =>
  fc.uniqueArray(fc.hexaString({ minLength: 4, maxLength: 12 }), {
    minLength: n,
    maxLength: n,
  });

describe("AC-REC-5 (R-INV-1) -- recovery disposition depends only on seq/store-membership, never on id content", () => {
  it("for any watermark, the set of resubmitted SEQs equals {seq > watermark}, regardless of which hex string labels each seq", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            ids: idPoolArb(n),
            watermark: fc.integer({ min: 0, max: n }),
          }),
        ),
        async ({ n, ids, watermark }) => {
          const submittedSeqs = await recoverAndCollectResubmittedSeqs(ids, watermark);
          const expectedSeqs = Array.from({ length: n }, (_, i) => i + 1).filter(
            (seq) => seq > watermark,
          );
          expect(submittedSeqs).toEqual(expectedSeqs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("id reshuffling invariance: relabeling which hex id string occupies which seq position never changes the resubmitted-seq set", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            idsA: idPoolArb(n),
            watermark: fc.integer({ min: 0, max: n }),
            shuffleSeed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
          }),
        ),
        async ({ idsA, watermark, shuffleSeed }) => {
          // Deterministic Fisher-Yates shuffle of idsA, seeded per-run, to
          // produce idsB: the SAME id pool, permuted to different seq
          // positions -- store membership (which ids exist) and every
          // fact's seq assignment (position i -> seq i+1) both stay fixed;
          // only the id<->seq PAIRING changes.
          const idsB = [...idsA];
          let rngState = shuffleSeed;
          const nextRand = () => {
            rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
            return rngState / 0x7fffffff;
          };
          for (let i = idsB.length - 1; i > 0; i--) {
            const j = Math.floor(nextRand() * (i + 1));
            [idsB[i], idsB[j]] = [idsB[j], idsB[i]];
          }

          const resultA = await recoverAndCollectResubmittedSeqs(idsA, watermark);
          const resultB = await recoverAndCollectResubmittedSeqs(idsB, watermark);

          expect(resultB).toEqual(resultA);
        },
      ),
      { numRuns: 100 },
    );
  });
});
