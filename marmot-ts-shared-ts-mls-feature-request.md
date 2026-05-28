# Feature Request: Declare `ts-mls` a peer dependency so consumers and marmot-ts share one instance

**To:** marmot-ts maintainers
**From:** notestr-web (downstream consumer, same-org fork co-developers)
**Type:** Packaging / public-API type-safety defect
**Affects:** `@internet-privacy/marmot-ts@0.6.0` (and every prior version that exposes `ts-mls` types in its public API)
**Severity:** High — blocked downstream type-checked builds (`tsc` / `next build`).
**Status:** ✅ **Resolved** — marmot-ts now declares `ts-mls` as a `peerDependency` (commit *"Declare ts-mls as a peer dependency"* on `addressable-key-packages`), and notestr-web consumes the **packed tarball**. Verified downstream: single `ts-mls` instance, `npx tsc --noEmit` → 0 errors, `make build` green.

---

## 0. Resolution summary (read this first)

Two halves, both landed:

1. **Fork:** `ts-mls` moved from `dependencies` → `peerDependencies` (kept in `devDependencies` for the fork's own build/test). The packed/published package therefore carries **no** `ts-mls`; the host supplies the single copy.
2. **Consumer:** depend on the **packed tarball** (`pnpm pack` → `marmot-ts.tgz`), not a `file:` symlink to the dev tree. The tarball excludes `devDependencies`, so npm installs marmot-ts as a real directory with no sibling `ts-mls`, deduping to the consumer's single copy.

**A pnpm `workspace:*` / live-symlink consumption does NOT work** and must not be used as the "live edit" shortcut — see §5.2. It reintroduces two virtual `ts-mls` instances via a transitive `@noble/ciphers` version skew. The tarball is the validated consumption shape.

---

## 1. Summary

marmot-ts re-exposes **`ts-mls` types in its public API** (e.g. `MarmotGroup.state: ClientState`, `group.propose(action: ProposalAction<Proposal>)`, the `getPubkeyLeafNodeIndexes(state)` re-export). `ts-mls` brands several of those types with a **`unique symbol`** (`CustomExtension[__custom_extension_brand]`).

When marmot-ts declared `ts-mls` as a **regular `dependency`**, a consumer that also depends on `ts-mls` ended up with **two physical copies** in its module graph. `unique symbol` brands are identity-based, so the two copies' types **do not unify even at the identical version**. Every place the consumer passed a marmot-ts-produced `ts-mls` value (e.g. `group.state`) into a `ts-mls` function — or vice versa — became a `TS2345` "not assignable" error, and the type-checked build failed.

---

## 2. Environment / evidence (pre-fix)

- `@internet-privacy/marmot-ts@0.6.0`, `ts-mls@2.0.0-rc.10` (marmot-ts pinned it exactly).
- Consumer: notestr-web (TypeScript, `moduleResolution: "bundler"`, `strict`, Next.js build), which **also** declares `"ts-mls": "^2.0.0-rc.10"` and imports `ts-mls` primitives directly (`getOwnLeafNode`, `defaultProposalTypes`, `nodeTypes`, `defaultKeyPackageEqualityConfig`).
- Consumer installed marmot-ts via `"@internet-privacy/marmot-ts": "file:<fork>/dist"`, a **symlink** to the fork build tree.

Representative error (9 total, same class):

```
src/components/DeviceList.tsx(104,35): error TS2345: Argument of type
  'import(".../marmot-ts/node_modules/.pnpm/ts-mls@2.0.0-rc.10.../ts-mls/dist/src/clientState").ClientState'
  is not assignable to parameter of type
  'import(".../notestr-web/node_modules/ts-mls/dist/src/clientState").ClientState'.
    Property '[__custom_extension_brand]' is missing in type '...marmot-ts/.../CustomExtension'
      but required in type '...notestr-web/.../CustomExtension'.
```

---

## 3. Root cause

1. **`ts-mls` uses nominal (branded) types** — a `unique symbol` is identity-bound to its declaration site, so the same declaration compiled into two physically distinct package copies yields two incompatible brands. Structural equality is not enough. (This is correct, intentional `ts-mls` design — not a bug there.)
2. **marmot-ts bundled its own `ts-mls`** and exposes `ts-mls` types across its public API surface. A second copy in the consumer's graph guarantees the brand mismatch.

The duplicate is guaranteed whenever the resolved location of marmot-ts has a sibling `node_modules/ts-mls` — i.e. under a `file:`/`link:`/`workspace` consumption of a dev tree.

Because the mismatch only surfaces under whole-program type-checking, it is **invisible to per-file transpilers** (vitest/esbuild pass while `tsc`/`next build` fail).

---

## 4. Impact

- **Build-blocking** for any consumer that type-checks and either also depends on `ts-mls` or consumes marmot-ts via link/workspace.
- **Silent under unit tests** (transpile-only).
- **No safe downstream-only workaround** existed: `tsconfig` `paths` alias for `ts-mls` had no effect (marmot-ts's `.d.ts` resolve `ts-mls` by realpath); copying marmot-ts into `node_modules` broke its other deps; `preserveSymlinks` requires all marmot-ts deps hoisted into the consumer. The fix had to live in marmot-ts.

---

## 5. The change (implemented)

### 5.1 `ts-mls` is a peer dependency ✅

```jsonc
{
  "peerDependencies": { "ts-mls": "2.0.0-rc.10" },
  "devDependencies":  { "ts-mls": "2.0.0-rc.10" }
  // removed from "dependencies"
}
```

- `peerDependencies` declares the single-instance contract; `devDependencies` keeps `ts-mls` available for the fork's own build/test.
- **Peer range:** exact `2.0.0-rc.10` for now (matches the consumer pin). Widen to a caret range once `ts-mls` ships a stable release — caret on a pre-release is intentionally narrow and won't match later `rc`s.

### 5.2 Consume the packed tarball — NOT a workspace/symlink ✅ (with a hard-won caveat)

The consumer must install marmot-ts such that its resolved location has **no sibling `ts-mls`**. The packed tarball achieves this (devDeps excluded). The consumer's Makefile now does: build fork `dist` → `pnpm pack` (scripts skipped) → depend on `file:.../marmot-ts.tgz` → `npm install`.

> **Caveat discovered during implementation — do not use a pnpm `workspace:*` for the type-check fixture / consumer to get "live edits".** Even with `peerDependencies` declared, pnpm created **two virtual `ts-mls` instances**: the workspace-root devDep `ts-mls` resolved with `@noble/ciphers@2.2.0` while the fixture's scope resolved `@noble/ciphers@2.1.1`, and pnpm keys its virtual store by full dependency resolution — so the two `ts-mls@2.0.0-rc.10` graphs were distinct store entries and their branded types still didn't unify. **Packing the tarball avoids this**: `devDependencies` (and thus `ts-mls` and its transitive `@noble`) are excluded, leaving exactly one `ts-mls` (the consumer's). This is the reason the tarball — not a workspace — is the supported topology.

### 5.3 Recommended: audit the rest of the public API for the same hazard

Any dependency whose **nominal/branded** types appear in marmot-ts's public API should also be a peer dependency. `ts-mls` was the one biting us; please also check anything else that uses `unique symbol`/branded/`declare`-merged types and is re-exposed. Plain structural interfaces (most `applesauce` event types) are safe.

### 5.4 Optional: tighten the boundary

Consider making marmot-ts the **sole** boundary to `ts-mls` for consumers — re-export the primitives consumers need (`getOwnLeafNode`, `defaultProposalTypes`, `nodeTypes`, `defaultKeyPackageEqualityConfig`, `getPubkeyLeafNodeIndexes`) so downstreams that don't otherwise need `ts-mls` can drop the direct dependency. Does not replace §5.1 for consumers that do use `ts-mls`.

---

## 6. Acceptance criteria (status)

- **AC-1 ✅** `ts-mls` under `peerDependencies` (+ `devDependencies`), not `dependencies`; packed manifest reflects it.
- **AC-2 ✅** A fresh consumer install resolves **exactly one** `ts-mls` (`npm ls ts-mls` → deduped; one `package.json` on disk).
- **AC-3 ✅** Downstream `tsc --noEmit` compiles with **zero** `TS2345` brand-mismatch errors (notestr-web: 9 → 0).
- **AC-4 ⚠️** "Live unbuilt-tree co-development with a single instance" is **not** met by a workspace (see §5.2). It is met by the tarball at the cost of a repack+reinstall per fork change. If a true live-edit single-instance loop is wanted, it requires deduping `@noble/*` across scopes (e.g. pinning identical `@noble/ciphers` everywhere) — tracked as a follow-up, not blocking.
- **AC-5 ✅** A peer-version mismatch surfaces as an explicit peer-dep warning, not a silent second copy.
- **AC-6 ☐** Document (README/CONTRIBUTING) that `ts-mls` is a peer dep, why (branded types ⇒ single instance), and the supported consumer topology (packed/published, not workspace).

---

## 7. Verification / regression guard

- **Downstream type-check smoke test in marmot-ts CI** (the single most valuable guard): a tiny fixture consumer (own `package.json`, depends on the **packed** marmot-ts + `ts-mls`) that runs `tsc --noEmit`. Note from §5.2: the fixture must consume the **tarball**, not `workspace:*`, or the guard itself trips the dual-instance bug.
- **Single-instance assertion** in the same job: `npm ls ts-mls` / `pnpm why ts-mls` resolves exactly one copy.

---

## 8. Alternatives considered

| Option | Verdict |
|---|---|
| Consumer `tsconfig` `paths` alias for `ts-mls` | **Rejected** — marmot-ts's `.d.ts` resolve `ts-mls` by realpath, outside the consumer path map. Verified no effect. |
| Consumer copies marmot-ts into `node_modules` | **Rejected** — breaks marmot-ts's other deps (`eventemitter3` etc.). Verified worse. |
| Consumer `preserveSymlinks` | **Rejected** — requires all marmot-ts runtime deps hoisted into the consumer; not guaranteed for a linked package. |
| Bundle/inline `ts-mls` into marmot-ts output | **Rejected** — doesn't help consumers that also use `ts-mls` directly. |
| pnpm `workspace:*` / live symlink (for live edits) | **Rejected** — reintroduces two virtual `ts-mls` via transitive `@noble/ciphers` skew (§5.2). |
| `ts-mls` as **peer dependency** + **packed-tarball** consumption | **✅ Accepted & implemented** — single shared `ts-mls`; downstream `tsc`/`make build` green. |

---

## 9. Migration notes

- Moving a dependency to a peer dependency is a consumer-visible change — treat as at least a minor bump while pre-1.0, and note it in release notes. Consumers must declare `ts-mls` themselves (notestr-web already does).
- No runtime behavior change; this is a dependency-graph/type-identity fix. Emitted JS is unchanged.

---

## 10. References

- marmot-ts commit *"Declare ts-mls as a peer dependency"* (`addressable-key-packages`).
- `ts-mls@2.0.0-rc.10` — `CustomExtension` branded type (`[__custom_extension_brand]`).
- Downstream wiring: notestr-web `Makefile` (`node_modules` target packs the fork → `marmot-ts.tgz`); `CLAUDE.md` → "marmot-ts (we control the fork)".
- Downstream evidence: notestr-web `src/marmot/forget-device.ts`, `src/components/DeviceList.tsx:104`, `src/marmot/device-sync.ts`; `tsc --noEmit` 9 → 0.
