/**
 * adapter-lifecycle.structural.test.ts
 *
 * AC-BOUND-5 (Boundary Rule 10) — the static/grep half of the observable:
 * "a grep-based test asserts zero occurrences of useEffect/useState/useRef
 * in marmot-adapter.ts". The runtime half (unmount ordering) lives in
 * react-engine-hooks.test.tsx, since it needs an actual React render/
 * unmount cycle.
 *
 * Also enforces the companion structural half of Boundary Rule 10's text —
 * "react-engine-hooks.ts MUST manage exactly one useEffect per group" — via
 * a call-count scan of react-engine-hooks.ts itself.
 *
 * Self-referential-scan discipline (prior learning from
 * src/engine/engine-boundary.structural.test.ts): the scanner-liveness
 * fixture text is assembled from separate string parts at test-run time so
 * the literal hook-name-as-a-call ("useEffect" + "(") never appears as
 * contiguous on-disk text in THIS file's own source, which would otherwise
 * make this file flag itself.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const MARMOT_ADAPTER_FILE = resolve(__dirname, "marmot-adapter.ts");
const REACT_ENGINE_HOOKS_FILE = resolve(__dirname, "react-engine-hooks.ts");

/** React hook names assembled from parts so this file's own source never
 *  contains one of them as a contiguous, directly-matchable call form. */
const REACT_LIFECYCLE_HOOK_NAMES: ReadonlyArray<string> = [
  "use" + "Effect",
  "use" + "State",
  "use" + "Ref",
];

/**
 * Counts call-shaped occurrences of `hookName(` in `source`. Deliberately a
 * simple substring/call-shape scan (matching the project's established
 * structural-test idiom) rather than a full parser — a hook name followed
 * by `(` is call syntax in any realistic source, and a false-positive would
 * only ever be a code COMMENT mentioning the hook name immediately followed
 * by an opening paren, which is not a pattern real prose produces.
 */
function countHookCalls(source: string, hookName: string): number {
  const re = new RegExp(`\\b${hookName}\\s*\\(`, "g");
  const matches = source.match(re);
  return matches ? matches.length : 0;
}

describe("AC-BOUND-5: marmot-adapter.ts registers zero independent React lifecycle hooks", () => {
  const source = readFileSync(MARMOT_ADAPTER_FILE, "utf-8");

  for (const hookName of REACT_LIFECYCLE_HOOK_NAMES) {
    it(`contains zero ${hookName}( occurrences`, () => {
      expect(countHookCalls(source, hookName)).toBe(0);
    });
  }

  describe("scanner liveness (proves a real hook call flips this test)", () => {
    for (const hookName of REACT_LIFECYCLE_HOOK_NAMES) {
      it(`flips to nonzero when a ${hookName}( call is present in a scratch source string`, () => {
        const scratch = ["const x = ", hookName, "(", "null", ");"].join("");
        expect(countHookCalls(scratch, hookName)).toBe(1);
      });
    }
  });
});

describe("Boundary Rule 10: react-engine-hooks.ts manages exactly one useEffect per group", () => {
  const source = readFileSync(REACT_ENGINE_HOOKS_FILE, "utf-8");
  const effectHookName = "use" + "Effect";

  it("calls useEffect exactly once", () => {
    expect(countHookCalls(source, effectHookName)).toBe(1);
  });

  it("scanner liveness: two calls in a scratch source string count as two", () => {
    const scratch = [
      effectHookName,
      "(() => {}, []);\n",
      effectHookName,
      "(() => {}, []);\n",
    ].join("");
    expect(countHookCalls(scratch, effectHookName)).toBe(2);
  });
});
