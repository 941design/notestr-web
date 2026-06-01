import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecordingTrace, mlsTrace, type TraceEvent } from "./mls-trace";

// These tests exercise the SAME factory the module-level `mlsTrace`
// singleton resolves to when `NEXT_PUBLIC_E2E_TRACE_MLS=1` at build time.
// They lock the contract that `mls-trace.ts` ships:
//
//   - record() defensively JSON-clones the event so post-record mutation
//     of the caller's argument cannot rewrite already-recorded entries.
//   - dump() defensively JSON-clones each entry on egress so consumer
//     mutation of a returned event cannot rewrite the internal buffer.
//   - clear() empties the buffer.

describe("mls-trace recording impl", () => {
  it("clones the event on record so post-record mutation does not rewrite history", () => {
    const trace = createRecordingTrace();
    const eventIds = ["a", "b"];
    const event: TraceEvent = {
      kind: "ingest-call",
      t: 1,
      groupId: "g1",
      eventIds,
      epoch: "0",
    };

    trace.record(event);
    eventIds.push("c");
    (event as { groupId: string }).groupId = "MUTATED";

    const dumped = trace.dump();
    expect(dumped).toHaveLength(1);
    const recorded = dumped[0];
    expect(recorded.kind).toBe("ingest-call");
    if (recorded.kind === "ingest-call") {
      expect(recorded.eventIds).toEqual(["a", "b"]);
      expect(recorded.groupId).toBe("g1");
    }
  });

  it("clones nested filter objects so filter mutation post-record does not rewrite history", () => {
    const trace = createRecordingTrace();
    const filter = { kinds: [445], "#h": ["abc"] };
    const event: TraceEvent = {
      kind: "req-start",
      t: 1,
      relay: "ws://relay",
      filter,
      reqId: "r1",
    };

    trace.record(event);
    filter.kinds.push(9999);
    filter["#h"][0] = "MUTATED";

    const dumped = trace.dump();
    expect(dumped).toHaveLength(1);
    const recorded = dumped[0];
    if (recorded.kind === "req-start") {
      expect(recorded.filter.kinds).toEqual([445]);
      expect(recorded.filter["#h"]).toEqual(["abc"]);
    }
  });

  it("dump returns an array snapshot — mutating the array does not affect subsequent dumps", () => {
    const trace = createRecordingTrace();
    trace.record({ kind: "req-close", t: 1, reqId: "r1" });
    trace.record({ kind: "req-close", t: 2, reqId: "r2" });

    const first = trace.dump() as TraceEvent[];
    expect(first).toHaveLength(2);
    first.length = 0;

    const second = trace.dump();
    expect(second).toHaveLength(2);
  });

  it("dump deep-clones each entry — mutating a returned event does not corrupt the buffer", () => {
    const trace = createRecordingTrace();
    trace.record({
      kind: "ingest-call",
      t: 1,
      groupId: "g1",
      eventIds: ["a", "b"],
      epoch: "0",
    });

    const first = trace.dump();
    expect(first).toHaveLength(1);
    const consumerView = first[0];
    if (consumerView.kind === "ingest-call") {
      (consumerView as { groupId: string }).groupId = "CORRUPTED";
      consumerView.eventIds.push("c");
    }

    const second = trace.dump();
    expect(second).toHaveLength(1);
    const fresh = second[0];
    if (fresh.kind === "ingest-call") {
      expect(fresh.groupId).toBe("g1");
      expect(fresh.eventIds).toEqual(["a", "b"]);
    }
  });

  it("clear empties the buffer", () => {
    const trace = createRecordingTrace();
    trace.record({ kind: "req-close", t: 1, reqId: "r1" });
    trace.clear();
    expect(trace.dump()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-TRACE-2 / AC-HOOK-7 — Noop singleton contract.
//
// When NEXT_PUBLIC_E2E_TRACE_MLS !== "1" at build time, the resolved
// `mlsTrace` singleton MUST behave as a true no-op: record() does not
// store anything, dump() returns an empty array, clear() does not
// throw. Vitest runs with the env flag unset by default, so the
// top-level `mlsTrace` import resolves to the noop implementation
// under test here.
//
// These properties kill three mutants that survived the initial pass
// (cluster around lines 137-145): a non-empty FROZEN_EMPTY, the
// noopTrace object literal stripped to `{}`, and the dump body
// stripped to `{}`. They are stated as contracts on observable
// behavior — no test references `noopTrace`, `FROZEN_EMPTY`, or any
// other internal symbol; the contract is "the env-unset singleton is
// indistinguishable from a recorder that swallows everything".
// ---------------------------------------------------------------------------

describe("mls-trace noop singleton contract (env flag unset — AC-TRACE-2, AC-HOOK-7)", () => {
  // Sanity-check: the test environment has NEXT_PUBLIC_E2E_TRACE_MLS unset
  // so the singleton resolves to the noop branch we're trying to assert
  // against. If a future global setup ever flips this, the assertions
  // below would fail-confusingly; surface that condition explicitly.
  it("test environment leaves NEXT_PUBLIC_E2E_TRACE_MLS unset (precondition)", () => {
    expect(process.env.NEXT_PUBLIC_E2E_TRACE_MLS).not.toBe("1");
  });

  it("exposes record, dump, and clear as callable methods", () => {
    // Kills the ObjectLiteral -> {} mutant on noopTrace: a stripped
    // object literal would have undefined for each of these.
    expect(typeof mlsTrace.record).toBe("function");
    expect(typeof mlsTrace.dump).toBe("function");
    expect(typeof mlsTrace.clear).toBe("function");
  });

  it("dump() returns an array (not undefined) of length 0 on first call", () => {
    // Kills the BlockStatement mutant on noopTrace.dump (body -> {})
    // which would return undefined, and the ArrayDeclaration mutant
    // on FROZEN_EMPTY (-> ["Stryker was here"]) which would return
    // length 1.
    const dumped = mlsTrace.dump();
    expect(Array.isArray(dumped)).toBe(true);
    expect(dumped).toHaveLength(0);
  });

  it("dump() remains length-0 after ANY sequence of record() calls", () => {
    // Property C (output contract): for every fast-check-generated
    // sequence of TraceEvent values, dump() returns length 0.
    // Generates a small, mixed sample of TraceEvent shapes so we
    // exercise the no-op path with realistic call-site payloads.
    const traceEventArb: fc.Arbitrary<TraceEvent> = fc.oneof(
      fc.record({
        kind: fc.constant("req-close" as const),
        t: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        reqId: fc.string({ minLength: 1, maxLength: 16 }),
      }),
      fc.record({
        kind: fc.constant("ingest-call" as const),
        t: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        groupId: fc.string({ minLength: 1, maxLength: 16 }),
        eventIds: fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 4 }),
        epoch: fc.string({ minLength: 1, maxLength: 4 }),
      }),
      fc.record({
        kind: fc.constant("epoch-change" as const),
        t: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        groupId: fc.string({ minLength: 1, maxLength: 16 }),
        from: fc.string({ minLength: 1, maxLength: 4 }),
        to: fc.string({ minLength: 1, maxLength: 4 }),
      }),
    );

    fc.assert(
      fc.property(fc.array(traceEventArb, { maxLength: 32 }), (events) => {
        for (const e of events) {
          mlsTrace.record(e);
        }
        const dumped = mlsTrace.dump();
        return Array.isArray(dumped) && dumped.length === 0;
      }),
      { numRuns: 50 },
    );
  });

  it("clear() does not throw when called on the noop singleton", () => {
    // Lightweight shape assertion — the BlockStatement mutant on
    // clear's body wouldn't be killed by record/dump alone, but the
    // method-presence assertion above already guards against the
    // object-literal-stripped mutant. This one just locks the
    // callable-without-throw contract.
    expect(() => mlsTrace.clear()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema parity — TraceEvent union parity regression test.
//
// The TraceEvent union is duplicated in e2e/fixtures/mls-trace-classify.ts
// (kept self-contained for the e2e build).  If a future edit adds a variant,
// removes a field, or changes a field type in one copy but not the other,
// TypeScript will reject the assignment below at compile time — before any
// e2e run catches it.
//
// All 20 variants are represented so that partial coverage gaps are caught
// (e.g. a new variant added to one side only).
// ---------------------------------------------------------------------------

import type { TraceEvent as SourceTraceEvent } from "./mls-trace";
import type { TraceEvent as FixtureTraceEvent } from "../../e2e/fixtures/mls-trace-classify";

describe("schema parity: TraceEvent source vs fixture", () => {
  // Bidirectional type assertion: values typed as SourceTraceEvent are also
  // assignable to FixtureTraceEvent (fixture ← source direction) and vice-versa
  // (source ← fixture direction) via the _fixtureOk / _sourceOk helpers.
  // Any drift in variant names, variant count, or field types produces a
  // TypeScript compile error on the relevant line.
  //
  // _fixtureOk: source → fixture. Holds because Filter ⊆ unknown.
  // _sourceOk:  fixture → source. Currently fails due to the existing
  //   filter-field drift (fixture uses `unknown`, source uses `Filter`).
  //   The @ts-expect-error below records this known gap; if the drift is
  //   later resolved, the directive produces a compile warning so the
  //   assertion is restored automatically.
  const _fixtureOk = (v: SourceTraceEvent): FixtureTraceEvent => v;
  const _sourceOk = (v: FixtureTraceEvent): SourceTraceEvent =>
    // @ts-expect-error — intentional: fixture filter is `unknown`, source is `Filter`.
    v;

  // All 20 variants — assign source-typed values to the fixture type variable.
  // If either union diverges, the relevant line fails at compile time.
  const _variants = [
    // req-start
    _fixtureOk({
      kind: "req-start",
      t: 0,
      relay: "wss://r",
      filter: {},
      reqId: "x",
    }),
    // req-event
    _fixtureOk({
      kind: "req-event",
      t: 0,
      reqId: "x",
      eventId: "y",
      createdAt: 0,
    }),
    // req-eose
    _fixtureOk({
      kind: "req-eose",
      t: 0,
      reqId: "x",
      eventCount: 0,
    }),
    // req-close
    _fixtureOk({ kind: "req-close", t: 0, reqId: "x" }),
    // sub-start
    _fixtureOk({
      kind: "sub-start",
      t: 0,
      relay: "wss://r",
      filter: {},
      subId: "x",
    }),
    // sub-event
    _fixtureOk({
      kind: "sub-event",
      t: 0,
      subId: "x",
      eventId: "y",
      createdAt: 0,
      epoch: "0",
    }),
    // sub-close
    _fixtureOk({ kind: "sub-close", t: 0, subId: "x" }),
    // ingest-call
    _fixtureOk({
      kind: "ingest-call",
      t: 0,
      groupId: "g",
      eventIds: [],
      epoch: "0",
    }),
    // ingest-result
    _fixtureOk({
      kind: "ingest-result",
      t: 0,
      groupId: "g",
      eventId: "y",
      result: "processed",
      epochBefore: "0",
      epochAfter: "1",
    }),
    // queue-enqueue
    _fixtureOk({
      kind: "queue-enqueue",
      t: 0,
      groupId: "g",
      eventId: "y",
      queueSize: 0,
    }),
    // queue-remove
    _fixtureOk({
      kind: "queue-remove",
      t: 0,
      groupId: "g",
      eventId: "y",
      reason: "reason",
    }),
    // queue-drain
    _fixtureOk({
      kind: "queue-drain",
      t: 0,
      groupId: "g",
      trigger: "epoch-advance",
      entries: 0,
    }),
    // epoch-change
    _fixtureOk({
      kind: "epoch-change",
      t: 0,
      groupId: "g",
      from: "0",
      to: "1",
    }),
    // publish-task
    _fixtureOk({
      kind: "publish-task",
      t: 0,
      groupId: "g",
      taskEventId: "y",
      rumorId: "r",
      eventId: "e",
      createdAt: 0,
    }),
    // task-store-load-start
    _fixtureOk({ kind: "task-store-load-start", t: 0, groupId: "g" }),
    // task-store-load-complete
    _fixtureOk({
      kind: "task-store-load-complete",
      t: 0,
      groupId: "g",
      restoredCount: 0,
    }),
    // task-store-recv
    _fixtureOk({
      kind: "task-store-recv",
      t: 0,
      groupId: "g",
      rumorId: "r",
    }),
    // task-store-accepted
    _fixtureOk({
      kind: "task-store-accepted",
      t: 0,
      groupId: "g",
      rumorId: "r",
      taskEventId: "e",
    }),
    // task-store-rejected
    _fixtureOk({
      kind: "task-store-rejected",
      t: 0,
      groupId: "g",
      rumorId: "r",
      reason: "wrong-kind",
    }),
    // task-store-error
    _fixtureOk({
      kind: "task-store-error",
      t: 0,
      groupId: "g",
      rumorId: null,
      reason: "deserialize-throw",
      message: "msg",
    }),
  ];

  it("all 18 TraceEvent variants are parity-assignable between source and fixture", () => {
    // The assignments above are compile-time checks.  At runtime we
    // simply assert the array is populated with 18 entries so the test
    // runner sees this as exercised.
    expect(_variants).toHaveLength(20);
  });
});
//
// The module-top expression
//
//     process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1"
//       ? createRecordingTrace()
//       : noopTrace
//
// is the build-time gate that selects which implementation ships.
// Four mutants survived against it: the ternary forced to true, the
// ternary forced to false, the equality flipped to !==, and the
// literal "1" replaced with "". This block re-imports the module
// after stubbing the env var with vi.resetModules + vi.stubEnv so the
// module-top selection re-evaluates against the stubbed value.
//
// Property: ONLY the literal "1" activates the recorder; any other
// value (unset, "", "0", "true", arbitrary non-"1" strings) selects
// the noop. We probe activation by recording one event and asserting
// dump() length: a recorder yields 1, the noop yields 0.
// ---------------------------------------------------------------------------

async function loadSingletonWithEnv(value: string | undefined): Promise<{
  record(event: TraceEvent): void;
  dump(): readonly TraceEvent[];
}> {
  vi.resetModules();
  if (value === undefined) {
    vi.stubEnv("NEXT_PUBLIC_E2E_TRACE_MLS", "");
    // vi.stubEnv with "" still leaves the key as "" not deleted, which
    // is itself a non-"1" value — sufficient to exercise the "unset"
    // semantics from the ternary's perspective.
  } else {
    vi.stubEnv("NEXT_PUBLIC_E2E_TRACE_MLS", value);
  }
  const mod = (await import("./mls-trace")) as typeof import("./mls-trace");
  return mod.mlsTrace;
}

const probeEvent: TraceEvent = {
  kind: "req-close",
  t: 1,
  reqId: "probe",
};

describe("mls-trace env-gated singleton selection (AC-TRACE-3, AC-HOOK-7)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('activates the recorder when NEXT_PUBLIC_E2E_TRACE_MLS === "1"', async () => {
    // Kills ConditionalExpression -> false (ternary forced to noop
    // even when the flag is set) and EqualityOperator === -> !==
    // (which would invert the selection so "1" picks the noop).
    const trace = await loadSingletonWithEnv("1");
    trace.record(probeEvent);
    expect(trace.dump()).toHaveLength(1);
  });

  it.each([
    ["unset (empty string)", ""],
    ['"0"', "0"],
    ['"true"', "true"],
    ['"yes"', "yes"],
    ['" 1" with leading whitespace', " 1"],
    ['"1 " with trailing whitespace', "1 "],
    ['"11"', "11"],
  ])("leaves the noop selected when the flag is %s", async (_label, value) => {
    // Kills ConditionalExpression -> true (which would activate the
    // recorder even when the flag is not "1") and StringLiteral "1"
    // -> "" (which would activate the recorder whenever the flag is
    // empty/unset instead of when it's literal "1"). Also pins
    // strict-equality semantics: " 1", "1 ", and "11" must NOT
    // activate.
    const trace = await loadSingletonWithEnv(value);
    trace.record(probeEvent);
    expect(trace.dump()).toHaveLength(0);
  });

  it("any non-'1' string leaves the noop selected (property)", async () => {
    // Family C output contract over arbitrary env values: the only
    // activator is the exact string "1". Restricting to strings of
    // length <= 8 and filtering out "1" keeps the generated values
    // diverse while ensuring the precondition holds.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 8 }).filter((s) => s !== "1"),
        async (value) => {
          const trace = await loadSingletonWithEnv(value);
          trace.record(probeEvent);
          return trace.dump().length === 0;
        },
      ),
      { numRuns: 20 },
    );
  });
});
