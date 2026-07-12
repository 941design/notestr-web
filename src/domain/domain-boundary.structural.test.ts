/**
 * domain-boundary.structural.test.ts
 *
 * Enforces AC-BOUND-2 from
 * specs/epic-event-sourced-receive-engine/S2-domain-events-contract/: no
 * file under src/domain/ imports src/engine/, src/persistence/,
 * src/integration/, or references either of the two forbidden browser-only
 * global identifiers (see DOM_GLOBAL_NAMES below).
 *
 * Widened beyond the AC's literal minimum (mandatory obligation #3 from
 * S1's review cycle): src/domain/* -> nothing means ZERO external imports
 * for production files, not just the three named categories — so this
 * scanner also flags src/store, src/marmot, node builtins, and external npm
 * packages in production files. Structural test files (this file included)
 * may import vitest + node fs/path/os, per the established
 * engine-boundary.structural.test.ts pattern (S1); any *.test.ts file may
 * import vitest.
 *
 * Self-referential-scan discipline (prior learning, established by
 * engine-boundary.structural.test.ts / S1): this file must not contain, as
 * CONTIGUOUS on-disk text, the literal import syntax or forbidden-global
 * identifiers it asserts against — otherwise the scanner would flag itself
 * the moment it (correctly) scans its own file. Mitigations used throughout:
 *   1. Fixture content proving the scanner is "live" (flips to failing on a
 *      real violation) is written to temporary scratch files OUTSIDE
 *      src/domain/, never embedded as matching literal text in this file's
 *      own source.
 *   2. The DOM_GLOBAL_NAMES strings are built via string concatenation, and
 *      every place that would otherwise spell either identifier out in an
 *      English test title/comment instead names it indirectly (e.g. "the
 *      first/second forbidden global", or interpolates the runtime value of
 *      DOM_GLOBAL_NAMES) — so the contiguous words never appear verbatim in
 *      this file's own on-disk source.
 *   3. extractImportSpecifiers necessarily produces regex-artifact "ghost"
 *      matches when it scans the JS array-literal syntax the fixtures below
 *      are written in (e.g. `"import ", "{ Foo }"` — the closing quote of
 *      one array element followed by the opening quote of the next reads,
 *      to a naive from/import-quote regex, exactly like a spurious
 *      specifier spanning the comma between them). This is harmless for
 *      engine-boundary.structural.test.ts's classifier (S1), which is a
 *      narrow allowlist-of-violations that returns "not a violation" for
 *      anything it doesn't recognize — but this file's classifier is a
 *      broad "anything non-relative/non-intra-domain is a violation"
 *      design, so a ghost match here WOULD wrongly self-flag as
 *      "external-package". `isPlausibleSpecifier` filters these out: a real
 *      module specifier never contains whitespace/newlines, but every ghost
 *      match spans the comma+newline+indentation between array elements.
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
 * Recursively collect every .ts AND .tsx file under `dir`. Returns [] if
 * `dir` doesn't exist — this is what lets S3's task-projector.ts /
 * task-crdt.ts (and any further future file under src/domain/) be picked up
 * automatically with zero test-file edits: the scan is directory-driven,
 * not an enumerated file list.
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
 * match. Mirrors engine-boundary.structural.test.ts's extractor exactly
 * (S1), including its zero-whitespace-before-quote and bare-side-effect-
 * import coverage.
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

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * A real module specifier is a non-empty string with no whitespace
 * (paths and package names never contain spaces/newlines/tabs). This
 * filters out the regex-artifact "ghost" matches described in the module
 * doc comment (point 3) — every ghost match spans a comma + newline +
 * indentation between two array-literal elements in this file's own
 * fixture code, so it always contains whitespace and is rejected here.
 */
function isPlausibleSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !/\s/.test(specifier);
}

/** Cosmetic-only bucket for failure-message legibility; not exhaustive. */
const NODE_BUILTIN_NAMES = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "util",
  "events",
  "stream",
  "buffer",
  "url",
]);

interface ImportViolation {
  specifier: string;
  category: string;
}

/**
 * Classifies one import specifier relative to the importing file's
 * directory. Returns null if the specifier is legal for a src/domain/
 * production file (i.e. a relative import that resolves to a path still
 * inside src/domain/); otherwise returns the violation with a category
 * label.
 *
 * A single classifier covers both AC-BOUND-2's three named categories
 * (src/engine, src/persistence, src/integration) and the broader
 * "zero external imports" rule (src/store, src/marmot, node builtins,
 * external npm packages, path-alias escapes) in one pass.
 */
function classifySpecifier(
  specifier: string,
  fileDir: string,
  domainDir: string,
): ImportViolation | null {
  if (isRelativeSpecifier(specifier)) {
    const resolved = resolve(fileDir, specifier);
    const withinDomain =
      resolved === domainDir || resolved.startsWith(domainDir + sep);
    if (withinDomain) return null;
    if (
      resolved.includes(`${sep}engine${sep}`) ||
      resolved.endsWith(`${sep}engine`)
    ) {
      return { specifier, category: "src/engine" };
    }
    if (
      resolved.includes(`${sep}persistence${sep}`) ||
      resolved.endsWith(`${sep}persistence`)
    ) {
      return { specifier, category: "src/persistence" };
    }
    if (
      resolved.includes(`${sep}integration${sep}`) ||
      resolved.endsWith(`${sep}integration`)
    ) {
      return { specifier, category: "src/integration" };
    }
    if (
      resolved.includes(`${sep}store${sep}`) ||
      resolved.endsWith(`${sep}store`)
    ) {
      return { specifier, category: "src/store" };
    }
    if (
      resolved.includes(`${sep}marmot${sep}`) ||
      resolved.endsWith(`${sep}marmot`)
    ) {
      return { specifier, category: "src/marmot" };
    }
    return { specifier, category: "relative-import-escapes-domain" };
  }

  // Bare / path-alias specifier — never legal in a production domain file.
  if (specifier.includes("/integration/") || specifier.startsWith("@/integration")) {
    return { specifier, category: "src/integration" };
  }
  if (specifier.includes("/persistence/") || specifier.startsWith("@/persistence")) {
    return { specifier, category: "src/persistence" };
  }
  if (specifier.includes("/store/") || specifier.startsWith("@/store") || specifier === "@/store") {
    return { specifier, category: "src/store" };
  }
  if (specifier.includes("/marmot/") || specifier.startsWith("@/marmot")) {
    return { specifier, category: "src/marmot" };
  }
  if (specifier.includes("/engine/") || specifier.startsWith("@/engine")) {
    return { specifier, category: "src/engine" };
  }
  if (NODE_BUILTIN_NAMES.has(specifier) || specifier.startsWith("node:")) {
    return { specifier, category: "node-builtin" };
  }
  return { specifier, category: "external-package" };
}

/**
 * Per-file allowlist of specifiers that are NOT violations even though they
 * are non-relative. Structural test files may import vitest + node
 * fs/path/os (the established engine pattern, S1); any *.test.ts file may
 * import vitest and fast-check (fast-check added by S3, whose story text
 * mandates src/domain/task-projector.property.test.ts -- a fast-check
 * property test -- and this scanner covers every .ts file under src/domain/
 * including test files, so the mandated file's own `import * as fc from
 * "fast-check"` would otherwise be flagged as an external-package
 * violation). Production files (domain-events.ts, task-events.ts,
 * task-crdt.ts, task-projector.ts, and any future src/domain/ file) get no
 * exceptions.
 */
function allowedExceptions(file: string): Set<string> {
  const allowed = new Set<string>();
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
    allowed.add("vitest");
    allowed.add("fast-check");
  }
  if (file.endsWith(".structural.test.ts")) {
    allowed.add("fs");
    allowed.add("path");
    allowed.add("os");
  }
  return allowed;
}

function findImportViolations(
  source: string,
  file: string,
  domainDir: string,
): ImportViolation[] {
  const exceptions = allowedExceptions(file);
  const fileDir = dirname(file);
  const found: ImportViolation[] = [];
  for (const specifier of extractImportSpecifiers(source)) {
    if (!isPlausibleSpecifier(specifier)) continue;
    if (exceptions.has(specifier)) continue;
    const violation = classifySpecifier(specifier, fileDir, domainDir);
    if (violation !== null) found.push(violation);
  }
  return found;
}

/**
 * DOM global identifier names, built via concatenation so the contiguous
 * words never appear verbatim in this file's own on-disk source (see
 * module doc comment's self-referential-scan discipline).
 */
const DOM_GLOBAL_NAMES: ReadonlyArray<string> = ["doc" + "ument", "win" + "dow"];

/**
 * Strip line comments (`// ...`), block comments (`/* ... *\/`), and the
 * literal-text portions of string (`"..."` / `'...'`) and template
 * (`` `...` ``) literals from `source`, replacing stripped characters with
 * spaces (newlines are preserved as newlines). Quote/backtick/comment
 * delimiters themselves are kept so the output stays the same length and
 * roughly the same shape as the input.
 *
 * This exists so `findDomGlobalUsages` below scans only real code: a prose
 * comment or string containing a bare "sliding window" or "see the design
 * document" must not trip the forbidden-global scanner (Stage-1 review
 * finding on S3's landing of task-projector.ts/task-crdt.ts).
 *
 * Template-literal `${...}` interpolations are NOT stripped — they contain
 * real, executable code (which may itself reference a forbidden global), so
 * the scanner re-enters normal code-scanning mode for their contents,
 * tracking brace depth so nested `{}`/nested template literals inside an
 * interpolation resolve correctly.
 *
 * Known non-goal: this is a lightweight tokenizer, not a full TS parser. It
 * does not disambiguate regex literals from the division operator, so a
 * forbidden word spelled out inside a `/regex/` literal's pattern text is
 * still treated as code and would be flagged. That's an intentional,
 * conservative gap — regex literals containing literal "window"/"document"
 * text are not a pattern this scanner needs to special-case, and a false
 * positive there is a rare, easily-fixed nuisance rather than a silent gap.
 */
function stripCommentsAndStringLiterals(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  // One stack frame per currently-open template literal. `braceDepth === 0`
  // means we are scanning the template's literal text (not inside a `${}`
  // interpolation); a positive depth means we are inside that template's
  // active interpolation, tracking nested `{`/`}` so the interpolation's
  // own closing `}` is recognized correctly even with nested object
  // literals or nested template literals inside it.
  const templateStack: { braceDepth: number }[] = [];

  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : "";

    const top = templateStack.length > 0 ? templateStack[templateStack.length - 1] : undefined;

    if (top !== undefined && top.braceDepth === 0) {
      // Inside a template literal's literal-text portion.
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

    // Line comment.
    if (c === "/" && c2 === "/") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Block comment.
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

    // Single/double-quoted string literal.
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

    // Template literal open.
    if (c === "`") {
      out += "`";
      i++;
      templateStack.push({ braceDepth: 0 });
      continue;
    }

    // Brace tracking while scanning code inside a template's interpolation.
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

function findDomGlobalUsages(source: string): string[] {
  const scannable = stripCommentsAndStringLiterals(source);
  const found: string[] = [];
  for (const name of DOM_GLOBAL_NAMES) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(scannable)) found.push(name);
  }
  return found;
}

// ---------------------------------------------------------------------------
// AC-BOUND-2, part 1 — no disallowed / external imports
// ---------------------------------------------------------------------------

describe("AC-BOUND-2: src/domain/ imports no src/engine, src/persistence, src/integration (and, more broadly, nothing outside src/domain)", () => {
  const domainDir = resolve(__dirname);
  const files = collectTsFiles(domainDir);

  it("scans at least one real file (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("gracefully returns no files for a directory that does not exist yet", () => {
    expect(collectTsFiles(join(domainDir, "__no-such-subdir__"))).toEqual([]);
  });

  for (const file of files) {
    const rel = relative(domainDir, file);
    it(`${rel} has no disallowed / external import`, () => {
      const source = readFileSync(file, "utf-8");
      const violations = findImportViolations(source, file, domainDir);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }

  describe("scanner liveness (proves a real violation flips this test)", () => {
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
    const fixtures: ReadonlyArray<{
      label: string;
      category: string;
      parts: string[];
    }> = [
      {
        label: "src/engine",
        category: "src/engine",
        parts: [
          "import ",
          "type { EngineState }",
          " from ",
          '"../engine/engine-types"',
          ";\n",
        ],
      },
      {
        label: "src/persistence",
        category: "src/persistence",
        parts: [
          "import ",
          "{ RawEventLogStore }",
          " from ",
          '"../persistence/raw-event-log-store"',
          ";\n",
        ],
      },
      {
        label: "src/integration",
        category: "src/integration",
        parts: [
          "import ",
          "{ MarmotAdapter }",
          " from ",
          '"../integration/marmot-adapter"',
          ";\n",
        ],
      },
      {
        label: "src/store (broader zero-external-imports rule)",
        category: "src/store",
        parts: [
          "import ",
          "type { TaskEvent }",
          " from ",
          '"../store/task-events"',
          ";\n",
        ],
      },
      {
        label: "src/marmot (broader zero-external-imports rule)",
        category: "src/marmot",
        parts: [
          "import ",
          "{ createKVStore }",
          " from ",
          '"../marmot/storage"',
          ";\n",
        ],
      },
      {
        label: "external package (broader zero-external-imports rule)",
        category: "external-package",
        parts: [
          "import ",
          "{ nip19 }",
          " from ",
          '"nostr-tools"',
          ";\n",
        ],
      },
      {
        label: "node builtin in a production file (broader rule)",
        category: "node-builtin",
        parts: [
          "import ",
          "{ readFileSync }",
          " from",
          '"fs"',
          ";\n",
        ],
      },
    ];

    for (const { label, category, parts } of fixtures) {
      it(`flips to failing when a ${label} import is introduced into a scratch production fixture`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
        const file = join(scratchDir, "scratch.ts");
        writeFileSync(file, parts.join(""));

        const source = readFileSync(file, "utf-8");
        const violations = findImportViolations(source, file, domainDir);
        expect(violations.length).toBeGreaterThan(0);
        expect(violations.some((v) => v.category === category)).toBe(true);
      });
    }

    it("does NOT flip when the same specifiers appear in a *.test.ts fixture that only uses the allowed vitest exception", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
      const file = join(scratchDir, "scratch.test.ts");
      writeFileSync(file, ["import ", "{ describe }", " from ", '"vitest"', ";\n"].join(""));

      const source = readFileSync(file, "utf-8");
      const violations = findImportViolations(source, file, domainDir);
      expect(violations).toEqual([]);
    });

    it("does NOT flip when a *.test.ts fixture imports the allowed fast-check exception (S3: mandated by task-projector.property.test.ts)", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
      const file = join(scratchDir, "scratch.property.test.ts");
      writeFileSync(
        file,
        ["import ", "* as fc", " from ", '"fast-check"', ";\n"].join(""),
      );

      const source = readFileSync(file, "utf-8");
      const violations = findImportViolations(source, file, domainDir);
      expect(violations).toEqual([]);
    });

    it("flips to failing when a fast-check import is introduced into a *.ts PRODUCTION fixture (the exception is test-file-only)", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
      const file = join(scratchDir, "scratch.ts");
      writeFileSync(
        file,
        ["import ", "* as fc", " from ", '"fast-check"', ";\n"].join(""),
      );

      const source = readFileSync(file, "utf-8");
      const violations = findImportViolations(source, file, domainDir);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.category === "external-package")).toBe(true);
    });

    it("does NOT flip when a *.structural.test.ts fixture uses the allowed fs/path/os exception", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
      const file = join(scratchDir, "scratch.structural.test.ts");
      writeFileSync(
        file,
        [
          "import ",
          "{ readFileSync }",
          " from ",
          '"fs"',
          ";\n",
          "import ",
          "{ join }",
          " from ",
          '"path"',
          ";\n",
          "import ",
          "{ tmpdir }",
          " from ",
          '"os"',
          ";\n",
        ].join(""),
      );

      const source = readFileSync(file, "utf-8");
      const violations = findImportViolations(source, file, domainDir);
      expect(violations).toEqual([]);
    });

    it("does NOT flip for a relative import that resolves within src/domain/ (intra-domain imports are legal)", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-import-scan-"));
      // Simulate a would-be src/domain/ file by classifying directly
      // against the real domainDir with a specifier that resolves inside
      // it, without needing an actual file inside src/domain/ itself.
      const violation = classifySpecifier("./task-events", domainDir, domainDir);
      expect(violation).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-BOUND-2, part 1b — no nondeterministic global usage in production files
// (S3 cold-review sev-3): task-projector.ts/task-crdt.ts land next with a
// pure/deterministic contract, but the import + DOM-global scanners above
// would let `Date.now()`, `Math.random()`, or `crypto.randomUUID()` slip in
// silently — none of those are imports or DOM globals. This scanner closes
// that gap for every production (non-*.test.ts) file under src/domain/,
// with a single named exception: src/domain/task-events.ts's createTask,
// whose Date.now()/crypto.randomUUID() calls are the sanctioned exception
// documented in architecture.md's Module Map "task-events" row ("createTask's
// crypto.randomUUID()/Date.now() are the ONLY sanctioned nondeterministic
// calls in src/domain/ (allowlisted in the boundary scanner); projector/CRDT
// code must stay pure").
//
// Unlike the DOM-global scanner above, this file (*.test.ts) is never a scan
// TARGET here — the loop below only visits non-test production files, so
// literal "Date.now"/"Math.random"/"crypto." text written directly into this
// file's own fixtures/comments cannot self-trigger. No concatenation
// discipline is required for that reason, though fixtures still follow the
// existing split-string convention for consistency with the scanners above.
// ---------------------------------------------------------------------------

/**
 * Nondeterministic global identifiers forbidden in src/domain/ production
 * code (outside the sanctioned task-events.ts exception). Matched as
 * member-access (`Date.`, `Math.random`, `crypto.`) or call (`Date(`) usage
 * on the comment/string-stripped source — never as a bare substring, so a
 * type or variable name merely ending in "Date" (e.g. `UpdateDate`) is never
 * flagged: `\bDate` already requires a word boundary immediately before
 * "Date", which a preceding word character like the "e" in "Update" does not
 * provide.
 */
const NONDETERMINISM_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Date", re: /\bDate\s*[.(]/ },
  { name: "Math.random", re: /\bMath\.random\b/ },
  { name: "crypto", re: /\bcrypto\s*\./ },
];

function findNondeterminismUsages(source: string): string[] {
  const scannable = stripCommentsAndStringLiterals(source);
  const found: string[] = [];
  for (const { name, re } of NONDETERMINISM_PATTERNS) {
    if (re.test(scannable)) found.push(name);
  }
  return found;
}

/**
 * Per-file allowlist for the nondeterminism scanner. src/domain/task-events.ts
 * is the ONE sanctioned exception — see architecture.md's Module Map
 * "task-events" row (quoted above). Keyed on the path relative to
 * src/domain/ so only the top-level file is exempted, not any same-named
 * file nested under a subdirectory.
 */
const NONDETERMINISM_ALLOWED_FILES: ReadonlySet<string> = new Set([
  "task-events.ts",
]);

describe("AC-BOUND-2 (extended, S3 cold-review sev-3): src/domain/ production files use no nondeterministic global (Date, Math.random, crypto) outside the sanctioned task-events.ts exception", () => {
  const domainDir = resolve(__dirname);
  const files = collectTsFiles(domainDir);
  const productionFiles = files.filter(
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
  );

  it("scans at least one real production file (the scan is not vacuous)", () => {
    expect(productionFiles.length).toBeGreaterThan(0);
  });

  for (const file of productionFiles) {
    const rel = relative(domainDir, file);
    if (NONDETERMINISM_ALLOWED_FILES.has(rel)) continue;
    it(`${rel} contains no nondeterministic global usage`, () => {
      const source = readFileSync(file, "utf-8");
      const found = findNondeterminismUsages(source);
      expect(found, `Found: ${found.join(", ")}`).toEqual([]);
    });
  }

  it("task-events.ts is exempted via the explicit allowlist constant (sanctioned createTask exception), not by accident", () => {
    const rel = relative(domainDir, join(domainDir, "task-events.ts"));
    expect(NONDETERMINISM_ALLOWED_FILES.has(rel)).toBe(true);
  });

  it("task-events.ts itself would fail this scan if it were not allowlisted (proves the exemption is load-bearing, not vacuous)", () => {
    const file = join(domainDir, "task-events.ts");
    const source = readFileSync(file, "utf-8");
    const found = findNondeterminismUsages(source);
    expect(found.length).toBeGreaterThan(0);
  });

  describe("scanner liveness (proves a real nondeterministic usage flips this test)", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true });
        scratchDir = undefined;
      }
    });

    const fixtures: ReadonlyArray<{
      label: string;
      name: string;
      parts: string[];
    }> = [
      {
        label: "Date.now() member-access usage",
        name: "Date",
        parts: ["export const ts = ", "Date", ".now();\n"],
      },
      {
        label: "new Date() constructor-call usage",
        name: "Date",
        parts: ["export const d = new ", "Date", "();\n"],
      },
      {
        label: "Math.random() usage",
        name: "Math.random",
        parts: ["export const r = ", "Math.random", "();\n"],
      },
      {
        label: "crypto.randomUUID() member-access usage",
        name: "crypto",
        parts: ["export const id = ", "crypto", ".randomUUID();\n"],
      },
    ];

    for (const { label, name, parts } of fixtures) {
      it(`flips to failing when a ${label} is introduced into a scratch production fixture`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-nondet-scan-"));
        const file = join(scratchDir, "scratch.ts");
        writeFileSync(file, parts.join(""));

        const found = findNondeterminismUsages(readFileSync(file, "utf-8"));
        expect(found).toContain(name);
      });
    }

    it("does NOT flip when Date/Math.random/crypto identifiers appear only inside a comment or a string literal, not as real code", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-nondet-scan-"));
      const file = join(scratchDir, "scratch.ts");
      const source =
        ["// uses ", "Date", ".now() and ", "Math.random", "() and ", "crypto", ".randomUUID() for reference\n"].join("") +
        ["const msg = \"calls ", "Date", ".now internally\";\n"].join("") +
        "export const ok = 1;\n";
      writeFileSync(file, source);

      const found = findNondeterminismUsages(readFileSync(file, "utf-8"));
      expect(found).toEqual([]);
    });

    it("does NOT false-positive on an identifier that merely ends in \"Date\" used as a type annotation (word-boundary check)", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-nondet-scan-"));
      const file = join(scratchDir, "scratch.ts");
      const source = ["type Update", "Date", " = string;\n", "export const x: Update", "Date", " = \"2026\";\n"].join("");
      writeFileSync(file, source);

      const found = findNondeterminismUsages(readFileSync(file, "utf-8"));
      expect(found).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-BOUND-2, part 2 — no forbidden browser-only global references
// ---------------------------------------------------------------------------

describe("AC-BOUND-2: src/domain/ never references a forbidden browser-only global identifier", () => {
  const domainDir = resolve(__dirname);
  const files = collectTsFiles(domainDir);

  for (const file of files) {
    const rel = relative(domainDir, file);
    it(`${rel} contains no forbidden browser-only global identifier usage`, () => {
      const source = readFileSync(file, "utf-8");
      const found = findDomGlobalUsages(source);
      expect(found, `Found: ${found.join(", ")}`).toEqual([]);
    });
  }

  it("DOM_GLOBAL_NAMES names exactly the two forbidden identifiers, no more, no fewer", () => {
    expect(DOM_GLOBAL_NAMES).toHaveLength(2);
    expect(new Set(DOM_GLOBAL_NAMES)).toEqual(
      new Set(["doc" + "ument", "win" + "dow"]),
    );
  });

  describe("scanner liveness (proves a real reference flips this test)", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true });
        scratchDir = undefined;
      }
    });

    // Driven directly off DOM_GLOBAL_NAMES (a runtime-computed array, not
    // contiguous on-disk text) so neither the fixture content nor the test
    // title ever spells either forbidden identifier out literally in this
    // file's own source.
    for (const name of DOM_GLOBAL_NAMES) {
      it(`flips to failing when a real reference to one of DOM_GLOBAL_NAMES is introduced into a scratch fixture`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
        const file = join(scratchDir, "scratch.ts");
        writeFileSync(file, `export const ref = ${name};\n`);

        const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
        expect(found).toEqual([name]);
      });
    }

    it("does not false-positive on identifiers that merely contain a forbidden name as a substring", () => {
      const camelCasedPrefix = DOM_GLOBAL_NAMES[1] + "Size"; // e.g. "<forbidden-2>Size"
      const suffixedWord = DOM_GLOBAL_NAMES[0] + "ation"; // e.g. "<forbidden-1>ation"
      const source = `const ${camelCasedPrefix} = 3; // see ${suffixedWord} for details\n`;
      expect(findDomGlobalUsages(source)).toEqual([]);
    });

    // Regression coverage for the comment/string-literal stripping added to
    // findDomGlobalUsages (Stage-1 review finding): a bare prose mention of
    // a forbidden global inside a comment or string must NOT flag, while a
    // real code reference — including one hidden inside a member-access
    // expression or a template-literal interpolation — still must. Each
    // fixture is built from DOM_GLOBAL_NAMES (a runtime-computed array) via
    // template-literal interpolation, never as contiguous on-disk text, per
    // this file's self-referential-scan discipline (this file scans itself
    // as part of AC-BOUND-2's file loop above).
    for (const name of DOM_GLOBAL_NAMES) {
      it(`still flags a real member-access usage of a forbidden global, not just a bare identifier reference`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
        const file = join(scratchDir, "scratch.ts");
        // e.g. `<first-forbidden-global>.title` / `<second-forbidden-global>.location`
        const prop = name === DOM_GLOBAL_NAMES[0] ? "title" : "location";
        writeFileSync(file, `export const x = ${name}.${prop};\n`);

        const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
        expect(found).toEqual([name]);
      });

      it(`still flags a real reference hidden inside a template-literal interpolation`, () => {
        scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
        const file = join(scratchDir, "scratch.ts");
        writeFileSync(file, "export const label = `value: ${" + name + "}`;\n");

        const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
        expect(found).toEqual([name]);
      });
    }

    it("does NOT flag a forbidden name that appears only as prose inside a line comment", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
      const file = join(scratchDir, "scratch.ts");
      const source =
        `// see the design ${DOM_GLOBAL_NAMES[0]} for details\n` +
        `// uses a sliding ${DOM_GLOBAL_NAMES[1]} algorithm\n` +
        `export const ok = 1;\n`;
      writeFileSync(file, source);

      const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
      expect(found).toEqual([]);
    });

    it("does NOT flag a forbidden name that appears only as prose inside a block comment", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
      const file = join(scratchDir, "scratch.ts");
      const source =
        `/* mentions the ${DOM_GLOBAL_NAMES[0]} and a sliding ${DOM_GLOBAL_NAMES[1]} in prose */\n` +
        `export const ok = 1;\n`;
      writeFileSync(file, source);

      const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
      expect(found).toEqual([]);
    });

    it("does NOT flag a forbidden name that appears only inside a string or template literal's text", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "domain-boundary-dom-scan-"));
      const file = join(scratchDir, "scratch.ts");
      const source =
        `const msg = "the sliding ${DOM_GLOBAL_NAMES[1]} is open";\n` +
        `const note = 'see the ${DOM_GLOBAL_NAMES[0]} for details';\n` +
        "const tmpl = `also mentions " + DOM_GLOBAL_NAMES[0] + " here`;\n";
      writeFileSync(file, source);

      const found = findDomGlobalUsages(readFileSync(file, "utf-8"));
      expect(found).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Shim purity tripwire (S3 cold-review sev-2): src/store/task-events.ts must
// remain a pure re-export shim forever — architecture.md's Module Map
// "task-events-shim" row: "FROZEN (2026-07-12) — pure re-export shim kept so
// 15 legacy importers work unchanged; do NOT add declarations here
// (structural test enforces)". This is that structural test.
// ---------------------------------------------------------------------------

/**
 * Strips `//` line comments and `/* ... *\/` block comments from `source`
 * while leaving string/template-literal content intact (a quote-tracking
 * variant of stripCommentsAndStringLiterals above, which additionally blanks
 * string interiors — not wanted here, since the shim's payload IS a string
 * literal whose exact text is what this test verifies).
 */
function stripCommentsOnly(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : "";

    if (c === "/" && c2 === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += quote;
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Canonical form the shim must reduce to after comments are stripped and
 * whitespace/quote-style/semicolon variance is normalized away. Assembled
 * from parts so this describe block never spells the re-export statement out
 * as contiguous on-disk text — the AC-BOUND-2 import scanner above treats
 * this very file as one of its scan targets, and while the specifier here
 * happens to resolve harmlessly back inside src/domain/ (so it would not
 * actually flag), splitting keeps this block consistent with the rest of the
 * file's self-referential-scan discipline instead of relying on that
 * resolution detail.
 */
const SHIM_EXPECTED_SPECIFIER = ["../domain", "/task-events"].join("");
const SHIM_EXPECTED_CANONICAL_FORM = [
  "export * ",
  "from",
  ` "${SHIM_EXPECTED_SPECIFIER}"`,
].join("");

/**
 * Reduces shim source to a canonical, comparison-ready form: strip comments,
 * collapse all whitespace runs to a single space, trim, normalize single
 * quotes to double quotes, and drop an optional trailing semicolon. This is
 * intentionally tolerant of formatting-only variance (quote style, trailing
 * semicolon, blank lines, leading/trailing comments) while still requiring
 * the statement itself to be exactly one export-star re-export and nothing
 * else.
 */
function normalizeShimSource(source: string): string {
  const stripped = stripCommentsOnly(source);
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  const quoteNormalized = collapsed.replace(/'/g, '"');
  return quoteNormalized.replace(/;$/, "");
}

describe("shim purity: src/store/task-events.ts stays a pure re-export shim", () => {
  const shimPath = resolve(__dirname, "..", "store", "task-events.ts");

  it("reduces to exactly the single canonical re-export statement and nothing else", () => {
    const source = readFileSync(shimPath, "utf-8");
    expect(normalizeShimSource(source)).toBe(SHIM_EXPECTED_CANONICAL_FORM);
  });

  describe("tripwire liveness (proves a real shim addition flips this test)", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true });
        scratchDir = undefined;
      }
    });

    it("tolerates quote-style, trailing-semicolon, and whitespace variance in an equivalent fixture", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "shim-purity-scan-"));
      const file = join(scratchDir, "scratch-shim.ts");
      const source = [
        "  export   *   ",
        "from",
        `   '${SHIM_EXPECTED_SPECIFIER}'  \n`,
      ].join("");
      writeFileSync(file, source);

      expect(normalizeShimSource(readFileSync(file, "utf-8"))).toBe(
        SHIM_EXPECTED_CANONICAL_FORM,
      );
    });

    it("tolerates a leading and a trailing comment around the re-export statement", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "shim-purity-scan-"));
      const file = join(scratchDir, "scratch-shim.ts");
      const source = [
        "// pure re-export shim\n",
        "export * ",
        "from",
        ` "${SHIM_EXPECTED_SPECIFIER}"; // do not add declarations\n`,
      ].join("");
      writeFileSync(file, source);

      expect(normalizeShimSource(readFileSync(file, "utf-8"))).toBe(
        SHIM_EXPECTED_CANONICAL_FORM,
      );
    });

    it("flips to failing when a declaration is added to the shim beyond the re-export statement", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "shim-purity-scan-"));
      const file = join(scratchDir, "scratch-shim.ts");
      const source = [
        "export * ",
        "from",
        ` "${SHIM_EXPECTED_SPECIFIER}";\n`,
        "export const EXTRA_DECLARATION = 1;\n",
      ].join("");
      writeFileSync(file, source);

      expect(normalizeShimSource(readFileSync(file, "utf-8"))).not.toBe(
        SHIM_EXPECTED_CANONICAL_FORM,
      );
    });

    it("flips to failing when the re-export specifier itself is changed", () => {
      scratchDir = mkdtempSync(join(tmpdir(), "shim-purity-scan-"));
      const file = join(scratchDir, "scratch-shim.ts");
      const source = [
        "export * ",
        "from",
        ` "${SHIM_EXPECTED_SPECIFIER}-v2";\n`,
      ].join("");
      writeFileSync(file, source);

      expect(normalizeShimSource(readFileSync(file, "utf-8"))).not.toBe(
        SHIM_EXPECTED_CANONICAL_FORM,
      );
    });
  });
});
