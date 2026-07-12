/**
 * legacy-key-guard.structural.test.ts
 *
 * Enforces AC-MIG-1 from specs/epic-event-sourced-receive-engine/
 * architecture.md ("Documentation" note in raw-event-log-store.ts's module
 * doc comment): no file other than src/store/persistence.ts's pre-existing
 * `loadEvents`/`saveEvents`/`appendEvent`/`clearEvents` implementation may
 * write to the legacy IDB key `notestr:events:${groupId}`.
 *
 * src/marmot/storage.ts contains a PRE-EXISTING, legitimate migration
 * READ/copy of the same legacy key prefix (`migrateLegacyPartition`,
 * around the `k.startsWith("notestr:events:")` filter): it reads keys off
 * the legacy origin-only default store, then writes each value under a
 * DYNAMICALLY ENUMERATED `key` VARIABLE (`set(key, ..., taskTarget)`), never
 * a `notestr:events:` string literal at the write call site. The scanner
 * below is deliberately WRITE-CALL-SITE-SPECIFIC (inspects only the first
 * argument text of `setItem(`/`set(` calls) rather than a blanket
 * "any occurrence of the marker anywhere in the file" scan, precisely so it
 * does not false-positive on storage.ts's sanctioned read-then-copy-by-
 * variable pattern.
 *
 * JUDGMENT CALL (S4, not pinned down by the story brief -- flagged here and
 * in the implementing agent's final report rather than silently resolved):
 * src/marmot/storage.test.ts ALSO trips the scanner -- it contains a
 * pre-existing, out-of-scope-to-edit test fixture
 * (`it("migrates task event log from the legacy default keyval-store", ...)`)
 * that calls raw idb-keyval `set("notestr:` + `events:g1", ...)` directly
 * against the bare default store to SIMULATE pre-migration legacy data, so
 * `migrateLegacyPartition`'s read-and-copy behavior can be exercised. This is
 * a test-only, historical-state-simulation write (mirroring what a
 * pre-this-epic app version would already have persisted), not a new
 * production write path bypassing persistence.ts -- the same "pre-existing,
 * sanctioned, not a new violation" reasoning the AC's text applies to
 * storage.ts's read pattern, extended here to storage.test.ts's write-side
 * fixture for the identical migration-testing purpose. storage.test.ts is
 * therefore excluded below alongside persistence.ts. A stricter reading of
 * AC-MIG-1 that also wants test fixtures held to the letter of "no write
 * call site outside persistence.ts" would need to either rewrite this
 * fixture to seed data via a raw IDB connection (bypassing idb-keyval's
 * `set`, mirroring `readAllRaw`'s raw-connection pattern already used
 * elsewhere in storage.ts) or accept this as a second sanctioned exclusion --
 * both are out of this story's file scope (src/persistence/ only) to
 * resolve unilaterally.
 *
 * Self-referential-scan discipline (established house style, see
 * ../engine/engine-boundary.structural.test.ts and
 * ../domain/bound-4.structural.test.ts): this file's own source must never
 * contain, as CONTIGUOUS on-disk text, the literal string it scans for
 * (`"notestr:events:"` / `"notestr:events"`). Any marker used inside a live
 * regex/comparison is built via string concatenation. Fixture content
 * proving the scanner is "live" goes into temp scratch files (mkdtempSync
 * under os.tmpdir()) written OUTSIDE src/, cleaned up in `afterEach`, never
 * embedded as matching literal text in this file's own source.
 *
 * SCANNER RESIDUAL SCOPE (cold review remediation, P2-3): the write-opener
 * regex covers `setItem(`, bare idb-keyval `set(`, `update(` (storage.ts's
 * atomic read-modify-write, added alongside `KeyValueStoreBackend.updateItem`),
 * and `setMany(`. Two classes of write remain OUTSIDE this tripwire's reach
 * BY DESIGN, not by oversight -- residual enforcement for both is human
 * review, not this scanner:
 *  (1) VARIABLE-ROUTED writes, where the destination key is built in a
 *      helper function or bound to a variable before the write call site
 *      (e.g. `const k = someKey(groupId); store.setItem(k, ...)`, or
 *      storage.ts's own `migrateLegacyPartition` copy-by-`key`-variable
 *      pattern) -- the scanner inspects only the write call's first-argument
 *      TEXT, so a variable name never contains the marker literal even when
 *      the variable's runtime value does.
 *  (2) `store.put(value, key)` -- the raw IDBObjectStore method takes the
 *      VALUE first and the KEY second (opposite of idb-keyval's
 *      `set(key, value)`), so a first-argument scan keyed on "the first
 *      argument is the key" would need call-site-specific handling this
 *      scanner does not attempt; a literal legacy key as `put`'s second
 *      argument is also outside this regex's reach.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Shared scanning helpers (self-contained copy of the collectTsFiles idiom
// established by engine-boundary.structural.test.ts / bound-4.structural.test.ts
// -- not imported from either, per house style).
// ---------------------------------------------------------------------------

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".next", ".stryker-tmp", "dist", "out"]);

/** Recursively collect every .ts / .tsx file under `dir`. Returns [] if `dir` doesn't exist. */
function collectTsFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The marker: built via concatenation so the contiguous literal never
// appears as on-disk text in this file (self-referential-scan discipline).
// No trailing colon required, so it also catches "notestr:events" + groupId
// -style construction, not only the colon-suffixed form.
// ---------------------------------------------------------------------------

const LEGACY_KEY_MARKER = "notestr:" + "events";

// ---------------------------------------------------------------------------
// Write-call-site-specific scanner
// ---------------------------------------------------------------------------

/**
 * Returns true if `source` contains a write call (`setItem(` or bare
 * idb-keyval `set(`) whose FIRST ARGUMENT text contains the legacy-key
 * marker. Deliberately narrower than a blanket occurrence scan: a file
 * that merely *reads* or *mentions* the marker (e.g. storage.ts's
 * `k.startsWith(...)` filter, or a comment) is not flagged -- only a write
 * call whose destination-key argument itself contains the marker is.
 *
 * Algorithm:
 *  1. Find every occurrence of a write-call opener via
 *     /\b(?:setItem|set|update|setMany)\s*(?:<[^>]*>)?\s*\(/g -- `update(`
 *     covers storage.ts's atomic `updateItem` (its own first argument, like
 *     `setItem`/`set`, is the destination key); `setMany(` covers
 *     idb-keyval's batch write (its first argument is an array of
 *     `[key, value]` pairs, so a literal marker anywhere inside that array
 *     literal still falls inside the extracted "first argument" span below).
 *     The optional `(?:<[^>]*>)?` tolerates an explicit generic type
 *     argument between the identifier and the call parens (idb-keyval's
 *     `update<T>(...)`/`get<T>(...)` style, as used in storage.ts) -- without
 *     it, `update<T | undefined>(` would silently NOT be recognized as an
 *     opener at all.
 *  2. For each match, extract the first-argument text: scan forward from
 *     the opener's end index, tracking paren/bracket/brace depth (starting
 *     at 0), taking the substring up to the first top-level comma (depth 0)
 *     or the call's closing paren if there is only one argument.
 *  3. Check whether that first-argument text contains the marker.
 */
function containsWriteToLegacyKey(source: string): boolean {
  const opener = /\b(?:setItem|set|update|setMany)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = opener.exec(source)) !== null) {
    const argStart = m.index + m[0].length;
    let depth = 0;
    let end = source.length;

    for (let i = argStart; i < source.length; i++) {
      const c = source[i];
      if (c === "(" || c === "[" || c === "{") {
        depth++;
      } else if (c === ")" || c === "]" || c === "}") {
        if (c === ")" && depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        end = i;
        break;
      }
    }

    const firstArg = source.slice(argStart, end);
    if (firstArg.includes(LEGACY_KEY_MARKER)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Repo paths
// ---------------------------------------------------------------------------

const persistenceDir = resolve(__dirname);
const repoRoot = resolve(persistenceDir, "..", "..");
const srcDir = join(repoRoot, "src");
const persistenceTsPath = join(repoRoot, "src", "store", "persistence.ts");
const storageTsPath = join(repoRoot, "src", "marmot", "storage.ts");
// Pre-existing test fixture that simulates legacy data via a literal write
// -- see the JUDGMENT CALL note in the module doc comment above.
const storageTestTsPath = join(repoRoot, "src", "marmot", "storage.test.ts");
const thisFilePath = join(persistenceDir, "legacy-key-guard.structural.test.ts");

// ---------------------------------------------------------------------------
// AC-MIG-1
// ---------------------------------------------------------------------------

describe("AC-MIG-1: no write call site outside persistence.ts targets the legacy notestr:events: key", () => {
  const candidateFiles = collectTsFiles(srcDir).filter(
    (f) =>
      resolve(f) !== resolve(persistenceTsPath) &&
      resolve(f) !== resolve(thisFilePath) &&
      resolve(f) !== resolve(storageTestTsPath),
  );

  it("scans at least one real file (the scan is not vacuous)", () => {
    expect(candidateFiles.length).toBeGreaterThan(0);
  });

  const violations = candidateFiles
    .map((file) => relative(repoRoot, file))
    .filter((rel) => containsWriteToLegacyKey(readFileSync(join(repoRoot, rel), "utf-8")));

  it("no violating file writes to the legacy key outside persistence.ts", () => {
    expect(violations, `Violating files: ${violations.join(", ")}`).toEqual([]);
  });

  it("src/marmot/storage.ts (pre-existing migration read/copy) is NOT flagged (negative control)", () => {
    const source = readFileSync(storageTsPath, "utf-8");
    expect(containsWriteToLegacyKey(source)).toBe(false);
  });

  it(
    "src/store/persistence.ts's real write pattern (routed through a storageKey() " +
      "helper call, not an inline literal at the write call site) does NOT trip the " +
      "literal-text scanner even WITHOUT the exclusion applied -- empirically verified " +
      "below. This makes the AC-MIG-1 exclusion clause not load-bearing FOR persistence.ts's " +
      "CURRENT shape (its setItem() first argument is `storageKey(groupId)`, a function " +
      "call, never the literal marker text). The exclusion is still the correct guard per " +
      "the AC's explicit text, and future-proofs against a refactor that inlines the key " +
      "literal directly into the write call (which WOULD trip the scanner were persistence.ts " +
      "not excluded). Scanner liveness itself is proven separately below via scratch fixtures.",
    () => {
      const source = readFileSync(persistenceTsPath, "utf-8");
      expect(containsWriteToLegacyKey(source)).toBe(false);
    },
  );

  it(
    "src/marmot/storage.test.ts's exclusion IS load-bearing (unlike persistence.ts's): its " +
      "pre-existing legacy-data-seeding fixture (`set(\"notestr:events:g1\", ...)`, a literal " +
      "write, not a variable-routed one) WOULD be flagged as a violation if the exclusion " +
      "above were removed -- see the JUDGMENT CALL note in this file's module doc comment",
    () => {
      const source = readFileSync(storageTestTsPath, "utf-8");
      expect(containsWriteToLegacyKey(source)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Liveness / flip-proof (mandatory, mirrors the established house pattern)
// ---------------------------------------------------------------------------

describe("scanner liveness (proves containsWriteToLegacyKey flips on a real violation, discriminates write from read)", () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  it("flags a setItem( write whose first argument is a template literal built from the marker", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-write.ts");
    const source = [
      "someStore.setItem(",
      "`",
      "notestr:",
      "events:",
      "${groupId}",
      "`",
      ", data);\n",
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(true);
  });

  it("flags a bare idb-keyval set( write whose first argument is a string-concatenated marker", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-write-concat.ts");
    const source = [
      "await set(",
      '"',
      "notestr:",
      "events",
      '" + groupId, data);\n',
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(true);
  });

  it("does NOT flag a read-only .startsWith( pattern reproducing storage.ts's migration filter (write/read discrimination)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-read.ts");
    const source = [
      "const taskKeys = defaultKeys.filter((k) => k.startsWith(",
      '"',
      "notestr:",
      "events:",
      '"',
      "));\n",
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(false);
  });

  it("does NOT flag a setItem( write whose first argument is an unrelated key (no false positive on shape alone)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-unrelated-write.ts");
    const source = ["someStore.setItem(", '"', "unrelated-key", '"', ", data);\n"].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(false);
  });

  it("flags an update<T>( write with an explicit generic type argument (storage.ts's real call shape) whose first argument is the marker (P2-3)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-write-update-generic.ts");
    const source = [
      "await update<T | undefined>(",
      '"',
      "notestr:",
      "events:",
      '" + groupId, (old) => old, store);\n',
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(true);
  });

  it("flags an update( write (storage.ts's atomic updateItem opener) whose first argument is the marker (P2-3)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-write-update.ts");
    const source = [
      "await update(",
      '"',
      "notestr:",
      "events:",
      '" + groupId, (old) => old, store);\n',
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(true);
  });

  it("flags a setMany( write whose entries array contains the marker as a key (P2-3)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-write-setmany.ts");
    const source = [
      "await setMany([[",
      '"',
      "notestr:",
      "events:",
      '" + groupId, data]], store);\n',
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(true);
  });

  it("does NOT flag an update( write whose first argument (key) is unrelated (no false positive on shape alone)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "legacy-key-guard-scan-"));
    const file = join(scratchDir, "scratch-update-unrelated.ts");
    const source = [
      "await update(",
      '"',
      "unrelated-key",
      '"',
      ", (old) => old, store);\n",
    ].join("");
    writeFileSync(file, source);

    expect(containsWriteToLegacyKey(readFileSync(file, "utf-8"))).toBe(false);
  });
});
