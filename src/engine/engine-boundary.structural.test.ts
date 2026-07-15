/**
 * engine-boundary.structural.test.ts
 *
 * Enforces two acceptance criteria from
 * specs/epic-event-sourced-receive-engine/S1-engine-types-foundation/:
 *
 *  - AC-BOUND-1: no file under src/engine/ imports react, next,
 *    next/navigation, any src/integration/* file, or marmot-ts
 *    (architecture.md Boundary Rule 1).
 *  - AC-BOUND-3: no file other than engine-types.ts inlines one of the
 *    epic's five new IDB key literals (architecture.md Boundary Rule 8/9).
 *    Widened by S13 ("boundary-hardening-and-cutover-complete") to also
 *    guard the S10 outbox key (see engine-types.ts's OUTBOX_KEY_PREFIX /
 *    outboxKey) alongside the original four -- it is Rule-9-defined in
 *    engine-types.ts but was not structurally scanned for inlining
 *    elsewhere until this story. (Deliberately not spelled out as a
 *    contiguous literal here -- see the self-referential-scan discipline
 *    below.)
 *
 * Self-referential-scan discipline (prior learning): this file must not
 * contain, as CONTIGUOUS on-disk text, the literal import syntax or IDB key
 * literals it asserts against — otherwise the scanner would flag itself as
 * a violator the moment it (correctly) scans its own file. Two mitigations
 * are used throughout:
 *   1. Fixture content proving the scanner is "live" (flips to failing on a
 *      real violation) is written to temporary scratch files OUTSIDE
 *      src/engine/, never embedded as matching literal text in this file's
 *      own source.
 *   2. The IDB_KEY_MARKERS strings are built via string concatenation so
 *      the contiguous literal never appears verbatim in this file.
 */

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";
import type {
  AcceptedDomainEvent,
  AppendFactResult,
  EngineCheckpoint,
  EngineOutputEvent,
  IngestSignal,
  IngestSource,
  NostrEvent,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
  Unsubscribe,
} from "./engine-types";
import type { TaskEvent } from "../domain/task-events";

// ---------------------------------------------------------------------------
// Shared scanning helpers
// ---------------------------------------------------------------------------

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively collect every .ts AND .tsx file under `dir` (amended
 * 2026-07-12, Stage-2 cold review — P3-9: directory scans previously
 * missed .tsx files, a blind spot for any React component under a scanned
 * tree). Returns [] if `dir` doesn't exist.
 */
function collectTsFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every static/dynamic `import` and `require` specifier from TS
 * source text. Requires the opening and closing quote characters to match
 * (backreference \1) so a quote-type mismatch never produces a spurious
 * match.
 *
 * Alternatives, in order:
 *   - `from\s*"..."`        — named/default/namespace static import. Uses
 *     `\s*` (amended 2026-07-12, Stage-2 cold review — P3-10), not `\s+`:
 *     the keyword directly abutting the opening quote with zero
 *     intervening whitespace (e.g. minified/prettier-hostile source) was
 *     previously invisible to the scanner. (Deliberately not spelled out
 *     as a contiguous literal here — see the module doc comment's
 *     self-referential-scan discipline.)
 *   - `require(\s*"...")`   — CommonJS require
 *   - `import(\s*"...")`    — dynamic import call (no space before `(`)
 *   - `import\s+"..."`      — bare side-effect import (`import "x";`);
 *     the mandatory `\s+` before the quote is kept here (not widened to
 *     `\s*`) so this branch cannot re-match the dynamic-import or
 *     `from`-style forms already covered above (`import(` and `import "` /
 *     `import"` are structurally different — the latter still requires at
 *     least the keyword/quote boundary the `\s+` enforces against
 *     `import(...)`).
 */
function extractImportSpecifiers(source: string): string[] {
  const re = /(?:from\s*|require\(\s*|import\(\s*|import\s+)(["'])([^"']*)\1/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specifiers.push(m[2]);
  }
  return specifiers;
}

/**
 * Returns the disallowed-category name, or null if the specifier is fine.
 *
 * Amended 2026-07-12, Stage-2 cold review — P2-8: added `src/marmot` and
 * `src/persistence` (architecture.md Boundary Rules 1/9 — `src/engine/*`
 * may only reach `src/persistence/*` through the `PersistenceAdapter`
 * interface, never by importing an implementation file; `src/marmot/*` is
 * legacy migration-owned code the engine must never reach into directly).
 *
 * Added by S2 (DECIDER GATE, mandatory obligation from S1's review cycle):
 * `src/store`. `engine-types.ts` legally imported `../store/task-events`
 * only until S2 relocated `TaskEvent` ownership into `src/domain/` (see
 * src/domain/task-events.ts, src/domain/domain-events.ts) and flipped
 * engine-types.ts's import to `../domain/task-events`. That edge is now
 * DEAD — this category makes any reintroduction of an engine -> store
 * import a structural-test failure.
 */
function disallowedCategory(specifier: string): string | null {
  if (specifier === "react" || specifier.startsWith("react/") || specifier.startsWith("react-dom")) {
    return "react";
  }
  if (specifier === "next" || specifier.startsWith("next/")) {
    return "next";
  }
  if (
    specifier.includes("/integration/") ||
    specifier === "src/integration" ||
    specifier.endsWith("/integration") ||
    specifier.startsWith("@/integration")
  ) {
    return "src/integration";
  }
  if (specifier.includes("marmot-ts")) {
    return "marmot-ts";
  }
  if (
    specifier.includes("/marmot/") ||
    specifier === "src/marmot" ||
    specifier.endsWith("/marmot") ||
    specifier.startsWith("@/marmot")
  ) {
    return "src/marmot";
  }
  if (
    specifier.includes("/persistence/") ||
    specifier === "src/persistence" ||
    specifier.endsWith("/persistence") ||
    specifier.startsWith("@/persistence")
  ) {
    return "src/persistence";
  }
  if (
    specifier.includes("/store/") ||
    specifier === "src/store" ||
    specifier.endsWith("/store") ||
    specifier.startsWith("@/store")
  ) {
    return "src/store";
  }
  return null;
}

function findDisallowedImports(source: string): Array<{ specifier: string; category: string }> {
  const found: Array<{ specifier: string; category: string }> = [];
  for (const specifier of extractImportSpecifiers(source)) {
    const category = disallowedCategory(specifier);
    if (category !== null) found.push({ specifier, category });
  }
  return found;
}

// ---------------------------------------------------------------------------
// AC-BOUND-1 — no react / next / next-navigation / src-integration / marmot-ts
// ---------------------------------------------------------------------------

describe("AC-BOUND-1: src/engine/ imports no react, next, src/integration, or marmot-ts", () => {
  const engineDir = resolve(__dirname);
  const files = collectTsFiles(engineDir);

  it("scans at least one real file (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(engineDir, file);
    it(`${rel} has no disallowed import`, () => {
      const source = readFileSync(file, "utf-8");
      const violations = findDisallowedImports(source);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }

  describe("scanner liveness (proves a real violation flips this test, per VQ-S1-004)", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true });
        scratchDir = undefined;
      }
    });

    // Each fixture is assembled from separate array elements so the
    // contiguous "from \"<specifier>\"" text never appears verbatim in this
    // file's own source (see module doc comment).
    const fixtures: ReadonlyArray<{ label: string; parts: string[] }> = [
      { label: "react", parts: ["import ", "{ useState }", " from ", '"react"', ";\n"] },
      { label: "next", parts: ["import ", "Link", " from ", '"next/link"', ";\n"] },
      {
        label: "next/navigation",
        parts: ["import ", "{ useRouter }", " from ", '"next/navigation"', ";\n"],
      },
      {
        label: "src/integration",
        parts: ["import ", "{ Foo }", " from ", '"../integration/bar"', ";\n"],
      },
      {
        label: "marmot-ts",
        parts: [
          "import ",
          "{ MarmotGroup }",
          " from ",
          '"@internet-privacy/marmot-ts"',
          ";\n",
        ],
      },
      {
        // Bare side-effect import: no `from`, no `require(`/`import(` call
        // syntax — the blind spot this fixture guards against.
        label: "marmot-ts (bare side-effect import)",
        parts: ["import ", '"@internet-privacy/marmot-ts"', ";\n"],
      },
      {
        // No space between the `from` keyword and the opening quote
        // (split-string technique, amended 2026-07-12, Stage-2 cold
        // review — P3-10): proves the `\s*` widening actually catches the
        // zero-whitespace form, not just the always-spaced variant. The
        // label and parts below deliberately never place the keyword
        // directly adjacent to the quote as contiguous on-disk text (see
        // the module doc comment's self-referential-scan discipline) —
        // the join happens only in memory, at test-run time.
        label: "react (zero whitespace before the opening quote)",
        parts: ["import ", "{ useState }", " from", '"react"', ";\n"],
      },
      {
        // Added 2026-07-12, Stage-2 cold review — P2-8: proves the new
        // src/persistence forbidden-category is live.
        label: "src/persistence",
        parts: [
          "import ",
          "{ RawEventLogStore }",
          " from ",
          '"../persistence/raw-event-log-store"',
          ";\n",
        ],
      },
      {
        // Added by S2 (DECIDER GATE): proves the new src/store
        // forbidden-category is live — the engine -> store edge this
        // story closed (TaskEvent relocated to src/domain/) must never be
        // silently reintroduced.
        label: "src/store",
        parts: [
          "import ",
          "{ TaskEvent }",
          " from ",
          '"../store/task-events"',
          ";\n",
        ],
      },
    ];

    for (const { label, parts } of fixtures) {
      it(`flips to failing when a ${label} import is introduced into a scratch fixture`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "engine-boundary-import-scan-"));
        const file = join(scratchDir, "scratch.ts");
        writeFileSync(file, parts.join(""));

        const source = readFileSync(file, "utf-8");
        const violations = findDisallowedImports(source);
        expect(violations.length).toBeGreaterThan(0);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-BOUND-3 — engine-types.ts is the sole owner of the epic's IDB key
// literals
// ---------------------------------------------------------------------------

// Built via concatenation — see module doc comment.
const IDB_KEY_MARKERS: ReadonlyArray<{ name: string; marker: string }> = [
  { name: "raw-facts", marker: "notestr:" + "raw-facts:" },
  { name: "accepted-events", marker: "notestr:" + "accepted-events:" },
  { name: "engine-checkpoints", marker: "notestr:" + "engine-checkpoints:" },
  { name: "deferred-ids", marker: "notestr:" + "deferred-ids:" },
  // Added S13: the S10 publish-outbox IDB key. Rule-9-defined in
  // engine-types.ts (OUTBOX_KEY_PREFIX/outboxKey) since S10 but never
  // previously added to this scanner's protected set.
  { name: "outbox", marker: "notestr:" + "outbox:" },
];

function findInlinedIdbKeyMarkers(source: string): string[] {
  return IDB_KEY_MARKERS.filter((k) => source.includes(k.marker)).map((k) => k.name);
}

describe("AC-BOUND-3: only engine-types.ts inlines an epic IDB key literal", () => {
  const repoRoot = resolve(__dirname, "..", "..");
  const engineDir = resolve(__dirname);
  const srcDir = join(repoRoot, "src");
  const engineTypesFile = join(engineDir, "engine-types.ts");

  // Widened 2026-07-12, Stage-2 cold review — P2-8: scans ALL of src/
  // (recursive, .ts + .tsx), not just src/engine/ + src/persistence/ — an
  // inlined key literal anywhere else in the app (e.g. an already-existing
  // src/marmot/ or src/store/ file, or a future component) is exactly the
  // violation AC-BOUND-3 exists to catch, so the scan must not be scoped
  // to only the directories the epic itself introduces. engine-types.ts is
  // the sole excluded file. Directories that don't exist yet still resolve
  // gracefully via collectTsFiles([missing dir]) === [].
  const candidateFiles = collectTsFiles(srcDir).filter(
    (f) => resolve(f) !== resolve(engineTypesFile),
  );

  it("gracefully returns no files for a directory that does not exist yet", () => {
    expect(collectTsFiles(join(repoRoot, "src", "__no-such-dir__"))).toEqual([]);
  });

  for (const file of candidateFiles) {
    const rel = relative(repoRoot, file);
    it(`${rel} does not inline an epic IDB key literal`, () => {
      const found = findInlinedIdbKeyMarkers(readFileSync(file, "utf-8"));
      expect(found, `Found markers: ${found.join(", ")}`).toEqual([]);
    });
  }

  it("engine-types.ts defines every IDB key marker (it is the sole authority)", () => {
    const source = readFileSync(engineTypesFile, "utf-8");
    const missing = IDB_KEY_MARKERS.filter((k) => !source.includes(k.marker)).map((k) => k.name);
    expect(missing).toEqual([]);
  });

  describe("scanner liveness (proves an inlined literal flips this test, per prior learning)", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true });
        scratchDir = undefined;
      }
    });

    for (const { name, marker } of IDB_KEY_MARKERS) {
      it(`flips to failing when ${name} is inlined outside engine-types.ts`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "engine-boundary-idb-scan-"));
        const file = join(scratchDir, "scratch-leak.ts");
        writeFileSync(file, "export const leaked = `" + marker + "${groupId}`;\n");

        const found = findInlinedIdbKeyMarkers(readFileSync(file, "utf-8"));
        expect(found).toEqual([name]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level assertions (post-impl, answers VQ-S1-009 / VQ-S1-010 with real
// compile-time evidence rather than argument-by-absence alone). These run
// under `npx tsc --noEmit`: a signature drift fails the typecheck gate, not
// just this file.
// ---------------------------------------------------------------------------

describe("type-level contract assertions (post-impl)", () => {
  it("IngestSignal has exactly five variants, no drift", () => {
    expectTypeOf<IngestSignal["type"]>().toEqualTypeOf<
      "message" | "deferred" | "skipped" | "malformed" | "epoch_advanced"
    >();
  });

  it("IngestSignal.skipped carries a seq-less fact, not just factId (amended 2026-07-12, Codex review — P2)", () => {
    expectTypeOf<Extract<IngestSignal, { type: "skipped" }>>().toEqualTypeOf<{
      type: "skipped";
      fact: RawProtocolFactInput;
    }>();
  });

  it("IngestSignal.message/deferred/malformed carry RawProtocolFactInput (seq-less), not RawProtocolFact", () => {
    expectTypeOf<
      Extract<IngestSignal, { type: "message" }>["fact"]
    >().toEqualTypeOf<RawProtocolFactInput>();
    expectTypeOf<
      Extract<IngestSignal, { type: "deferred" }>["fact"]
    >().toEqualTypeOf<RawProtocolFactInput>();
    expectTypeOf<
      Extract<IngestSignal, { type: "malformed" }>["fact"]
    >().toEqualTypeOf<RawProtocolFactInput>();
  });

  it("EngineOutputEvent has exactly ten variants, no drift", () => {
    expectTypeOf<EngineOutputEvent["type"]>().toEqualTypeOf<
      | "envelope_received"
      | "envelope_deferred"
      | "domain_event_accepted"
      | "domain_event_rejected"
      | "projection_invalidated"
      | "group_epoch_advanced"
      | "group_ratchet_advanced"
      | "engine_state_changed"
      | "deferred_retry_started"
      | "recovered"
    >();
  });

  it("PersistenceAdapter exposes exactly the ten architecture.md-specified methods with matching signatures", () => {
    expectTypeOf<PersistenceAdapter["appendFact"]>().toEqualTypeOf<
      (fact: RawProtocolFactInput) => Promise<AppendFactResult>
    >();
    expectTypeOf<PersistenceAdapter["loadFacts"]>().toEqualTypeOf<
      (groupId: string) => Promise<RawProtocolFact[]>
    >();
    expectTypeOf<PersistenceAdapter["appendAcceptedEvent"]>().toEqualTypeOf<
      (event: AcceptedDomainEvent) => Promise<void>
    >();
    expectTypeOf<PersistenceAdapter["loadAcceptedEvents"]>().toEqualTypeOf<
      (groupId: string) => Promise<AcceptedDomainEvent[]>
    >();
    expectTypeOf<PersistenceAdapter["saveCheckpoint"]>().toEqualTypeOf<
      (checkpoint: EngineCheckpoint) => Promise<void>
    >();
    expectTypeOf<PersistenceAdapter["loadCheckpoint"]>().toEqualTypeOf<
      (groupId: string) => Promise<EngineCheckpoint | null>
    >();
    expectTypeOf<PersistenceAdapter["saveDeferredIds"]>().toEqualTypeOf<
      (groupId: string, ids: string[]) => Promise<void>
    >();
    expectTypeOf<PersistenceAdapter["loadDeferredIds"]>().toEqualTypeOf<
      (groupId: string) => Promise<string[]>
    >();
    expectTypeOf<PersistenceAdapter["acceptDeferredFact"]>().toEqualTypeOf<
      (groupId: string, factId: string, event: AcceptedDomainEvent) => Promise<void>
    >();
    // Added 2026-07-12, Stage-2 cold review — P1-2 / P2-4 / P2-5: FSM L11
    // reset() full per-group purge.
    expectTypeOf<PersistenceAdapter["clearGroupState"]>().toEqualTypeOf<
      (groupId: string) => Promise<void>
    >();

    // Exactly ten methods -- no extra surface a caller could accidentally rely on.
    expectTypeOf<keyof PersistenceAdapter>().toEqualTypeOf<
      | "appendFact"
      | "loadFacts"
      | "appendAcceptedEvent"
      | "loadAcceptedEvents"
      | "saveCheckpoint"
      | "loadCheckpoint"
      | "saveDeferredIds"
      | "loadDeferredIds"
      | "acceptDeferredFact"
      | "clearGroupState"
    >();
  });

  it("IngestSource exposes exactly the five architecture.md-specified methods with matching signatures (amended 2026-07-12, S5 Stage-1 review — sev-6: fetchBootstrap added)", () => {
    expectTypeOf<IngestSource["catchUp"]>().toEqualTypeOf<() => AsyncIterable<IngestSignal>>();
    expectTypeOf<IngestSource["openLive"]>().toEqualTypeOf<
      (onSignal: (signal: IngestSignal) => void) => Unsubscribe
    >();
    expectTypeOf<IngestSource["ingestPersisted"]>().toEqualTypeOf<
      (facts: RawProtocolFact[]) => AsyncIterable<IngestSignal>
    >();
    // Added 2026-07-12, S5 Stage-1 review — sev-6: dedicated joining-phase
    // bootstrap channel, distinct from catchUp() (which is reserved
    // exclusively for the catching_up cutover drain, invoked exactly once
    // per engine start()).
    expectTypeOf<IngestSource["fetchBootstrap"]>().toEqualTypeOf<
      () => AsyncIterable<IngestSignal>
    >();
    expectTypeOf<IngestSource["close"]>().toEqualTypeOf<() => void>();

    // Exactly five methods -- no extra surface a caller could accidentally rely on.
    expectTypeOf<keyof IngestSource>().toEqualTypeOf<
      "catchUp" | "openLive" | "ingestPersisted" | "fetchBootstrap" | "close"
    >();
  });

  it("AcceptedDomainEvent (re-exported from src/domain/domain-events.ts, S2) matches architecture.md's seam table exactly — factId is non-null string, not string|null", () => {
    expectTypeOf<AcceptedDomainEvent>().toEqualTypeOf<{
      id: string;
      factId: string;
      sourceKind: "mls-rumor" | "bootstrap-kind-30078";
      groupId: string;
      acceptedAt: number;
      epoch: string;
      payload: TaskEvent;
    }>();
  });

  it("no marmot-ts type reaches IngestSignal/RawProtocolFact fields (proof by absence + structural typing)", () => {
    // TypeScript cannot resolve a type name that was never imported, and
    // the AC-BOUND-1 suite above proves engine-types.ts imports zero
    // marmot-ts symbols. This assertion pins the one field architecture.md
    // calls out explicitly (RawProtocolFact.nostrEvent) to the locally
    // declared structural NostrEvent, never an SDK-specific type.
    expectTypeOf<RawProtocolFact["nostrEvent"]>().toEqualTypeOf<NostrEvent>();
  });
});
