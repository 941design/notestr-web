/**
 * bound-4.structural.test.ts
 *
 * Enforces AC-BOUND-4 from
 * specs/epic-event-sourced-receive-engine/acceptance-criteria.md (backing
 * architecture.md's Implementation Constraint 10):
 *
 *   AC-BOUND-4 (Implementation Constraint 10) -- "Both the task projector's
 *   `applyEvent` and the bootstrap merge gate MUST call `taskWinsOver` from
 *   `src/domain/task-crdt.ts`; neither call site MUST implement an
 *   independent three-level (`updatedAt`/`updatedBy`/`updatedByDevice`)
 *   comparator."
 *
 *   Implementation Constraint 10 (architecture.md) -- "`task-crdt.ts` is the
 *   single tie-break authority. Both `applyEvent` (`task-reducer.ts:18-32`)
 *   and the bootstrap merge gate (`device-sync.ts:1433-1452`) must delegate
 *   to `taskWinsOver`. Any new tie-break logic must go into `task-crdt.ts`;
 *   implementing it independently in either call site reconstitutes the
 *   duplicate-projection drift risk."
 *
 * This test has two parts:
 *   1. Import-assertion: src/domain/task-projector.ts and
 *      src/marmot/device-sync.ts each import `taskWinsOver` from
 *      src/domain/task-crdt.ts and actually call it.
 *   2. Repo-wide duplicate-comparator scan: every .ts/.tsx file under src/
 *      is scanned for a "three-level comparator fingerprint" (a strict
 *      updatedAt > comparison, a strict updatedBy < comparison that is not
 *      updatedByDevice, and any mention of updatedByDevice). Any match
 *      outside the canonical implementation (and its co-located parity
 *      test) or the explicitly time-boxed legacy allowlist is a violation --
 *      this is what would catch the duplicated bootstrap-gate comparator
 *      that existed at device-sync.ts:1433-1452 before migration, were it
 *      ever reintroduced VERBATIM (same operand order: `updatedAt >`,
 *      `updatedBy <`, a mention of `updatedByDevice`). This is a
 *      textual-fingerprint tripwire, not a semantic analyzer: an
 *      operand-reversed (`existing.updatedAt < candidate.updatedAt`),
 *      aliased-field, or split-across-functions reimplementation of the
 *      same three-level tie-break is outside this scan's reach. Part 1's
 *      import-and-call assertions (both call sites must import and invoke
 *      the real `taskWinsOver`) are the primary guard against a duplicated
 *      comparator; this scan is a secondary, narrower tripwire against the
 *      literal reintroduction pattern that actually occurred historically.
 *
 * Self-referential-scan discipline (established by
 * domain-boundary.structural.test.ts / S1/S2): fixture content proving the
 * scanner is "live" is written to scratch files OUTSIDE src/, assembled from
 * separate string parts so the contiguous banned expression never appears as
 * literal on-disk text in this file itself -- this file is scanned by its
 * own repo-wide loop, and it is not in either allowlist.
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
import { dirname, join, relative, resolve, sep } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Shared scanning helpers (mirrors domain-boundary.structural.test.ts's
// house style; not imported from it -- this file is fully self-contained).
// ---------------------------------------------------------------------------

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".stryker-tmp",
  "dist",
  "out",
]);

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

/**
 * Strip line comments, block comments, and the literal-text portions of
 * string/template literals from `source`, replacing stripped characters
 * with spaces (newlines preserved). Template-literal `${...}` interpolations
 * are NOT stripped, since they contain real executable code. This exists so
 * the fingerprint scanner below only matches real code, not a comment or
 * string that merely mentions the field names in prose.
 */
function stripCommentsAndStringLiterals(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const templateStack: { braceDepth: number }[] = [];

  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : "";
    const top = templateStack.length > 0 ? templateStack[templateStack.length - 1] : undefined;

    if (top !== undefined && top.braceDepth === 0) {
      if (c === "\\" && i + 1 < n) {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "`") {
        out += "`";
        templateStack.pop();
        i++;
        continue;
      }
      if (c === "$" && c2 === "{") {
        out += "${";
        top.braceDepth = 1;
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }

    if (c === "/" && c2 === "/") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += quote;
        i++;
      }
      continue;
    }

    if (c === "`") {
      out += "`";
      i++;
      templateStack.push({ braceDepth: 0 });
      continue;
    }

    if (top !== undefined) {
      if (c === "{") {
        top.braceDepth++;
      } else if (c === "}") {
        top.braceDepth--;
        if (top.braceDepth === 0) {
          out += "}";
          i++;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * Extract every static/dynamic `import` / `require` specifier from TS
 * source text. Mirrors domain-boundary.structural.test.ts's extractor.
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
 * Returns true if a relative `specifier`, resolved against `fileDir`,
 * points at `targetPath` -- tolerating the specifier omitting the `.ts`
 * extension (e.g. `./task-crdt` resolving to `task-crdt.ts`).
 */
function specifierResolvesTo(specifier: string, fileDir: string, targetPath: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const resolved = resolve(fileDir, specifier);
  return resolved === targetPath || `${resolved}.ts` === targetPath || `${resolved}.tsx` === targetPath;
}

// ---------------------------------------------------------------------------
// Repo paths
// ---------------------------------------------------------------------------

const domainDir = resolve(__dirname);
const repoRoot = resolve(domainDir, "..", "..");
const srcDir = join(repoRoot, "src");
const taskCrdtPath = join(domainDir, "task-crdt.ts");
const taskProjectorPath = join(domainDir, "task-projector.ts");
const deviceSyncPath = resolve(repoRoot, "src", "marmot", "device-sync.ts");

// ---------------------------------------------------------------------------
// Part 1: import-assertion at both call sites
// ---------------------------------------------------------------------------

describe("AC-BOUND-4: both call sites import and call taskWinsOver from src/domain/task-crdt.ts", () => {
  const callSites: ReadonlyArray<{ label: string; path: string }> = [
    { label: "task-projector.ts (applyEvent)", path: taskProjectorPath },
    { label: "device-sync.ts (bootstrap merge gate)", path: deviceSyncPath },
  ];

  for (const { label, path } of callSites) {
    it(`${label} imports taskWinsOver from a specifier resolving to src/domain/task-crdt.ts`, () => {
      const source = readFileSync(path, "utf-8");
      const fileDir = dirname(path);
      const specifiers = extractImportSpecifiers(source);
      const resolvesToTaskCrdt = specifiers.some((s) => specifierResolvesTo(s, fileDir, taskCrdtPath));
      expect(resolvesToTaskCrdt, `specifiers found: ${JSON.stringify(specifiers)}`).toBe(true);
    });

    it(`${label} calls taskWinsOver(`, () => {
      const source = readFileSync(path, "utf-8");
      expect(source.includes("taskWinsOver(")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Part 2: repo-wide duplicate three-level comparator scan
// ---------------------------------------------------------------------------

/**
 * Fingerprint regexes for the banned "independent three-level comparator"
 * shape. All three must match for a file to be flagged:
 *   1. AT_GT_RE: a strict `updatedAt >` comparison.
 *   2. BY_LT_RE: a strict `updatedBy <` comparison that is NOT
 *      `updatedByDevice <` -- `\bupdatedBy\b` requires a word boundary
 *      immediately after "updatedBy", which "updatedByDevice" does not have
 *      (both "y" and "D" are word characters, so there is no boundary
 *      between them). Verified empirically: `/\bupdatedBy\b\s*</` does NOT
 *      match the substring "updatedByDevice <".
 *   3. DEVICE_RE: the identifier `updatedByDevice` appearing anywhere.
 * Matched against comment/string-stripped source so a file that merely
 * mentions these field names in prose or a string is never flagged.
 */
const AT_GT_RE = /\bupdatedAt\b\s*>/;
const BY_LT_RE = /\bupdatedBy\b\s*</;
const DEVICE_RE = /\bupdatedByDevice\b/;

function matchesComparatorFingerprint(source: string): boolean {
  const scannable = stripCommentsAndStringLiterals(source);
  return AT_GT_RE.test(scannable) && BY_LT_RE.test(scannable) && DEVICE_RE.test(scannable);
}

/**
 * The one canonical implementation, plus its co-located parity test.
 * task-crdt.test.ts intentionally reconstructs the exact legacy inline
 * expression in a `legacyInlineComparator` helper to assert `taskWinsOver`
 * agrees with it on an adversarial matrix -- direct evidence of the "preserve
 * behavior EXACTLY" extraction requirement (task-crdt.ts's own doc comment).
 * That is proof-of-equivalence for the ONE canonical implementation, not a
 * second production call site reimplementing the tie-break independently,
 * so it is not a AC-BOUND-4 violation.
 */
const CANONICAL_FILES: ReadonlySet<string> = new Set([
  "src/domain/task-crdt.ts",
  "src/domain/task-crdt.test.ts",
]);

/**
 * Allowlisted with expiry: task-reducer.ts is retired (replaced by
 * task-projector.ts) at S9 (task-store-projection-cutover) or S12
 * (legacy-listener-removal). Remove this entry when that lands.
 */
const ALLOWLISTED_LEGACY_FILES: ReadonlySet<string> = new Set([
  "src/store/task-reducer.ts",
]);

describe("AC-BOUND-4: no second function independently compares updatedAt/updatedBy/updatedByDevice", () => {
  const files = collectTsFiles(srcDir);

  it("scans at least one real file (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const matches = files
    .map((file) => ({ file, rel: relative(repoRoot, file).split(sep).join("/") }))
    .filter(({ file }) => matchesComparatorFingerprint(readFileSync(file, "utf-8")));

  it("the canonical implementation (task-crdt.ts) matches the fingerprint -- it is exempted only via CANONICAL_FILES, not by accident", () => {
    const rels = matches.map((m) => m.rel);
    expect(rels).toContain("src/domain/task-crdt.ts");
  });

  it("the allowlisted legacy file (task-reducer.ts) matches the fingerprint -- it is exempted only via ALLOWLISTED_LEGACY_FILES, not by accident", () => {
    const rels = matches.map((m) => m.rel);
    expect(rels).toContain("src/store/task-reducer.ts");
  });

  it("task-projector.ts and device-sync.ts do NOT match the fingerprint (S3 migration delegated both call sites to taskWinsOver)", () => {
    const rels = matches.map((m) => m.rel);
    expect(rels).not.toContain("src/domain/task-projector.ts");
    expect(rels).not.toContain("src/marmot/device-sync.ts");
  });

  const violations = matches
    .map((m) => m.rel)
    .filter((rel) => !CANONICAL_FILES.has(rel) && !ALLOWLISTED_LEGACY_FILES.has(rel));

  it("no file outside the canonical implementation and the time-boxed legacy allowlist matches the duplicate-comparator fingerprint", () => {
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 3: scanner liveness (proves a real reintroduction flips this test)
// ---------------------------------------------------------------------------

describe("scanner liveness (proves matchesComparatorFingerprint flips on a real reintroduction)", () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  // Reconstructs the exact inline comparator body that lived at
  // device-sync.ts:1439-1447 before Task 1 of this story deleted it,
  // assembled from separate array elements so the contiguous banned
  // expression never appears as literal on-disk text in this file's own
  // source (self-referential-scan discipline, module doc comment).
  const originalBootstrapComparatorParts: string[] = [
    "const existing = accepted.get(task.id);\n",
    "const wins =\n",
    "  !existing ||\n",
    "  task.",
    "updatedAt",
    " > existing.",
    "updatedAt",
    " ||\n",
    "  (task.",
    "updatedAt",
    " === existing.",
    "updatedAt",
    " &&\n",
    "    (task.",
    "updatedBy",
    " < existing.",
    "updatedBy",
    " ||\n",
    "      (task.",
    "updatedBy",
    " === existing.",
    "updatedBy",
    " &&\n",
    "        (task.",
    "updatedByDevice",
    ' ?? "") < (existing.',
    "updatedByDevice",
    ' ?? ""))));\n',
  ];

  it("flags a violation when the original device-sync.ts bootstrap comparator is reproduced in a scratch fixture", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bound-4-comparator-scan-"));
    const file = join(scratchDir, "scratch-bootstrap-gate.ts");
    writeFileSync(file, originalBootstrapComparatorParts.join(""));

    const found = matchesComparatorFingerprint(readFileSync(file, "utf-8"));
    expect(found).toBe(true);
  });

  it("does NOT flag when the same field names appear only inside a comment or string, not as real comparator code", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bound-4-comparator-scan-"));
    const file = join(scratchDir, "scratch-prose-only.ts");
    const source =
      ["// mentions ", "updatedAt", " > and ", "updatedBy", " < and ", "updatedByDevice", " in prose\n"].join("") +
      ["const msg = \"", "updatedAt", " > x and ", "updatedBy", " < y and ", "updatedByDevice", "\";\n"].join("") +
      "export const ok = 1;\n";
    writeFileSync(file, source);

    expect(matchesComparatorFingerprint(readFileSync(file, "utf-8"))).toBe(false);
  });

  it("does NOT flag when only two of the three fingerprint conditions are present (partial match is not a violation)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bound-4-comparator-scan-"));
    const file = join(scratchDir, "scratch-partial.ts");
    // Has updatedAt > and updatedBy <, but no updatedByDevice mention at all.
    const source = ["const wins = task.", "updatedAt", " > existing.", "updatedAt", " || task.", "updatedBy", " < existing.", "updatedBy", ";\n"].join("");
    writeFileSync(file, source);

    expect(matchesComparatorFingerprint(readFileSync(file, "utf-8"))).toBe(false);
  });

  it("does NOT flag a real reference to updatedByDevice < updatedByDevice on its own (BY_LT_RE's word-boundary must not misfire on updatedByDevice)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bound-4-comparator-scan-"));
    const file = join(scratchDir, "scratch-device-only.ts");
    const source = ["const x = task.", "updatedByDevice", " < existing.", "updatedByDevice", ";\n"].join("");
    writeFileSync(file, source);

    // BY_LT_RE alone should not match this (no bare updatedBy < present),
    // so the full fingerprint (which also needs AT_GT_RE) cannot match either.
    expect(BY_LT_RE.test(source)).toBe(false);
    expect(matchesComparatorFingerprint(readFileSync(file, "utf-8"))).toBe(false);
  });
});
