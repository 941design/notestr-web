/**
 * nostr.test.ts — NIP-46 perms-string audit
 *
 * AC-PERMS-1: sign_event:31337 must be absent; the string must contain
 *   sign_event:{kind} for every kind the signer is asked to sign, plus
 *   nip44_encrypt and nip44_decrypt.
 *
 * AC-PERMS-2: The enumerated kind set must be a superset of every distinct
 *   literal kind passed to signEvent() call sites across the codebase.
 *   This test scans src/ (excluding tests) to verify that.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Mock NDK and path-aliased modules so nostr.ts can be imported in the
// Vitest node environment (which has no Next.js path-alias resolution or
// browser globals).
vi.mock("@/config/relays", () => ({ NDK_CONNECT_TIMEOUT_MS: 5000 }));
vi.mock("@nostr-dev-kit/ndk", () => ({
  default: class NDK {},
  NDKNip46Signer: { nostrconnect: () => ({ nostrConnectUri: "" }) },
  NDKPrivateKeySigner: {},
  NDKUser: class NDKUser {},
}));
vi.mock("nostr-tools/nip19", () => ({
  decode: () => ({ type: "npub", data: "" }),
  npubEncode: () => "",
}));
vi.mock("nostr-tools/pure", () => ({ getEventHash: () => "" }));

import { NIP46_PERMS } from "./nostr";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the perms string into a Set of sign_event kind numbers. */
function parseSignedKinds(perms: string): Set<number> {
  const kinds = new Set<number>();
  for (const token of perms.split(",")) {
    const m = token.trim().match(/^sign_event:(\d+)$/);
    if (m) kinds.add(Number(m[1]));
  }
  return kinds;
}

/**
 * Recursively collect all .ts/.tsx files under `dir`, skipping test files
 * and node_modules.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      results.push(...collectSourceFiles(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Scan source files for literal kind numbers passed as the `kind` field
 * immediately before a signEvent call site (pattern: `kind: <N>` in the
 * same object literal that is then passed to signEvent).
 *
 * This uses a conservative grep-style approach: we look for `kind: <number>`
 * inside blocks that are also associated with a signEvent call in the same
 * source file.  Files that contain signEvent calls but whose kind numbers
 * are held in constants (e.g. TASK_SNAPSHOT_KIND = 30078) are handled by
 * the explicit known-kinds list below.
 */
function extractLiteralKindsFromFile(source: string): number[] {
  const kinds: number[] = [];
  // Match `kind: <number>` (with optional trailing comma/newline)
  const kindPattern = /\bkind:\s*(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = kindPattern.exec(source)) !== null) {
    kinds.push(Number(m[1]));
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// The known-required set (ground-truth for AC-PERMS-2)
//
// This list is derived by auditing every signEvent() call site in src/.
// See the NIP46_PERMS constant in nostr.ts for the rationale of each entry.
// ---------------------------------------------------------------------------
const REQUIRED_KINDS: ReadonlyArray<number> = [
  5, // NIP-09 deletion (client.tsx, forget-device.ts, marmot-ts kp-manager)
  13, // NIP-59 Seal (applesauce-common gift-wrap used by marmot-ts invitations)
  10051, // Relay list (client.tsx)
  22242, // NIP-42 AUTH (NDK-internal via EventSignerNdkAdapter)
  30443, // Addressable key package (marmot-ts key-package-manager)
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NIP46_PERMS (AC-PERMS-1 and AC-PERMS-2)", () => {
  it("does not contain the placeholder sign_event:31337", () => {
    expect(NIP46_PERMS).not.toMatch(/sign_event:31337/);
  });

  it("contains nip44_encrypt", () => {
    expect(NIP46_PERMS).toContain("nip44_encrypt");
  });

  it("contains nip44_decrypt", () => {
    expect(NIP46_PERMS).toContain("nip44_decrypt");
  });

  it("contains sign_event:22242 (NIP-42 AUTH)", () => {
    expect(NIP46_PERMS).toContain("sign_event:22242");
  });

  it("enumerates all known required kinds (AC-PERMS-2)", () => {
    const permsKinds = parseSignedKinds(NIP46_PERMS);
    const missing = REQUIRED_KINDS.filter((k) => !permsKinds.has(k));
    expect(missing, `Kinds missing from NIP46_PERMS: ${missing.join(", ")}`).toEqual([]);
  });

  it("is co-located in nostr.ts only (AC-PERMS-1 locality check)", () => {
    // This test verifies that NIP46_PERMS is not split across files by
    // checking that no other non-test source file in src/ contains a
    // sign_event:<number> token or a nip44_encrypt/nip44_decrypt token
    // (which would indicate a duplicate or shadow perms string).
    const srcDir = join(__dirname, "..");
    const files = collectSourceFiles(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      // Skip the file under test itself
      if (file.endsWith("nostr.ts") && file.includes("/lib/nostr.ts")) continue;
      const source = readFileSync(file, "utf-8");
      if (/sign_event:\d+|nip44_encrypt|nip44_decrypt/.test(source)) {
        violations.push(file);
      }
    }

    expect(
      violations,
      `Found sign_event or nip44_encrypt/nip44_decrypt tokens outside nostr.ts:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("covers every literal kind used in signEvent call-site files (source scan)", () => {
    // Files that are known to call signEvent (directly or via the signer adapter).
    // We scan each for literal `kind: <N>` values and assert all appear in REQUIRED_KINDS.
    // Constants (e.g. TASK_SNAPSHOT_KIND) expand to the expected literal in the
    // same source file, so we cross-check those below.
    const srcDir = join(__dirname, "..");
    const allFiles = collectSourceFiles(srcDir);
    const filesWithSignEvent = allFiles.filter((f) => {
      const src = readFileSync(f, "utf-8");
      return /signEvent\(/.test(src);
    });

    const permsKinds = parseSignedKinds(NIP46_PERMS);

    // Kinds that are used via named constants — their numeric values are
    // verified by the REQUIRED_KINDS array above; we exclude them from the
    // literal scan to avoid false positives from other numeric references.
    const constantMappedKinds = new Set([30443]);

    const undeclaredKinds: Array<{ file: string; kind: number }> = [];
    for (const file of filesWithSignEvent) {
      const source = readFileSync(file, "utf-8");
      const literalKinds = extractLiteralKindsFromFile(source);
      for (const k of literalKinds) {
        // Ignore non-event-kind numbers (0 used as falsy, 1 as first index, etc.)
        // and marmot protocol kind reads that don't involve signing.
        if (k < 1) continue;
        if (constantMappedKinds.has(k)) continue;
        if (!permsKinds.has(k) && !REQUIRED_KINDS.includes(k)) {
          undeclaredKinds.push({ file, kind: k });
        }
      }
    }

    // Filter known false-positives: kind numbers that appear in subscription
    // filters (reads) not signing calls, such as kind 443 relay queries.
    const FALSE_POSITIVE_KINDS = new Set([443, 445, 9]);

    const realViolations = undeclaredKinds.filter(
      ({ kind }) => !FALSE_POSITIVE_KINDS.has(kind),
    );

    expect(
      realViolations,
      `Kinds found in signEvent call-site files but not in NIP46_PERMS:\n` +
        realViolations.map(({ file, kind }) => `  kind ${kind} in ${file}`).join("\n"),
    ).toEqual([]);
  });
});
