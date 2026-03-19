# notestr Design Audit

## What's Working

- GitHub-inspired color system is solid. Light/dark tokens are well-defined in `globals.css` with semantic naming (`success`, `warning`, `destructive`).
- Dark mode works well — good contrast, card borders differentiate surfaces nicely.
- Auth screen layout is clean and centered, with clear hierarchy (heading > cards > actions).
- Shadcn/ui primitives provide consistent base components with proper `focus-visible` rings.
- `ThemeToggle` has proper `aria-label`.

---

## Critical Issues

### 1. Zero mobile/responsive support for the main app — HIGH

The main app layout (`page.tsx:372-396`) is completely rigid:

- `aside: w-[280px] shrink-0` — fixed 280px sidebar
- `main: grid-cols-3` — 3 fixed columns in `Board.tsx`

On any screen < 800px, the sidebar + 3 board columns overflow horizontally or crush to illegibility. There is no responsive breakpoint, no drawer, no hamburger menu. This is a PWA — it will be installed on phones.

**Decision: Three-tier responsive layout**

| Breakpoint | Sidebar | Board |
|---|---|---|
| < 768px | Overlay drawer with hamburger toggle in header | Swipeable tabs — one column at a time with Open / In Progress / Done tab headers, swipe to switch |
| 768–1024px | Collapsible icon rail (~56px), click to expand | 2-column grid with horizontal scroll for 3rd column |
| > 1024px | Current 280px sidebar (no change) | Current 3-column grid (no change) |

Mobile wireframe:
```
┌──────────────────────────┐
│ ☰  notestr  Group A  🌙 │  header
├──────────────────────────┤
│ [Open]  In Prog   Done   │  tabs
│──────────────────────────│
│ ┌──────────────────────┐ │
│ │ Task card 1          │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ Task card 2          │ │
│ └──────────────────────┘ │
│        ← swipe →         │
└──────────────────────────┘
```

Drawer wireframe (☰ tapped):
```
┌────────────┬─────────────┐
│ Groups     │░░░░░░░░░░░░░│
│ ─────────  │░ dimmed ░░░░│
│ Group A    │░ backdrop ░░│
│ Group B  ● │░░░░░░░░░░░░░│
│ + Create   │░░░░░░░░░░░░░│
└────────────┴─────────────┘
```

Tablet wireframe (icon rail):
```
┌───┬──────────────────────┐
│   │ notestr  Group A  🌙 │
│   ├──────────────────────┤
│ A │                      │
│   │  Open   │ In Prog    │
│ B │  ...    │ ...        │
│   │                      │
│ + │         (scroll →)   │
└───┴──────────────────────┘
 56px
```

### 2. Touch targets too small — HIGH

Per Material Design / Apple HIG, minimum touch target is 44–48px.

**Violations found:**

| Element | Location | Current size | Min required |
|---|---|---|---|
| Action buttons (`size="xs"`) | `TaskCard.tsx:78-85` | `h-6` (24px) | 44px |
| Auth tab triggers | `TabsTrigger` in auth flow | ~35px | 44px |
| Member list items | `GroupManager.tsx:219-228` | `py-1.5` (~30px) | 44px |
| Group list items | `GroupManager.tsx:149-162` | `py-2.5` (~40px) | 44px |

**Decision: Enlarge on touch devices via `@media (any-pointer: coarse)`**

Desktop keeps current compact sizing. Touch devices get `min-height: 44px` on all interactive elements. This gives the best of both worlds — dense desktop UI, accessible touch UI.

```css
@media (any-pointer: coarse) {
  .touch-target { min-height: 44px; }
}
```

### 3. No ARIA landmarks or roles on the board — MEDIUM

The kanban board (`Board.tsx`) has zero ARIA support:

- Board container is a bare `<div className="grid">` — should have `role="region"` with `aria-label="Task board"`
- Column divs have no role or `aria-label` — screen readers can't identify "Open", "In Progress", "Done" columns
- Task status changes are silent — no `aria-live` region to announce moves

**Decision: `role="region"` with labeled columns (not full grid navigation)**

Use `role="region"` with `aria-label` on the board and each column. Add an `aria-live="polite"` region to announce status changes. Full `role="grid"` keyboard navigation is deferred — it's significantly more work and can be added later.

### 4. Sidebar has no `<nav>` or ARIA navigation role — MEDIUM

`GroupManager.tsx:130` renders a `<div>` — should be `<nav aria-label="Groups">`. The group `<ul>` at line 147 has no role attribute. Selected group uses CSS styling but no `aria-current` or `aria-selected`.

**Fix:** Change outer `<div>` to `<nav aria-label="Groups">`, add `aria-current="true"` to the selected group item.

---

## Moderate Issues

### 5. No safe area handling for PWA standalone mode

The viewport meta tag doesn't include `viewport-fit=cover`. No usage of `env(safe-area-inset-*)` anywhere. On notched iPhones in standalone mode, the header and bottom actions will be obscured.

**Fix:** Add `viewport-fit=cover` to viewport meta, add `padding-top: env(safe-area-inset-top, 0px)` to the header and bottom padding where needed.

### 6. Card backgrounds in dark mode lack sufficient differentiation

In `TaskCard.tsx:52`, cards use `bg-background` inside columns that use `bg-card`. In dark mode, `background: #0d1117` vs `card: #161b22` — only ~3% luminance difference.

**Decision:** Add `shadow-sm` to cards in dark mode for visual lift, rather than reworking the color tokens.

### 7. Header lacks visual weight / app identity

The header (`page.tsx:197-202, 359-371`) is a thin `border-b bg-card` strip with just "notestr" text and a theme button.

**Decisions:**
- Add selected group name to header as breadcrumb (especially important on mobile where sidebar is hidden)
- Keep theme toggle as icon-only with `aria-label` (no text label needed)
- No logo for now — text mark is fine for MVP

### 8. Auth screen: "Connecting..." state lacks context

`page.tsx:204-208` shows a spinner with "Connecting..." — no indication of what's happening, no timeout, no retry. If the signer check fails silently, users see a brief flash before the auth screen.

**Fix:** Add a minimum display time or skip the spinner for faster loads. Add a timeout with retry option.

### 9. No empty state illustration or onboarding

When authenticated with no groups (`page.tsx:385-394`), the empty state is bare text: "Select a Group / Pick a group from the sidebar..."

**Decision:**
- Add a lucide icon (e.g., `LayoutDashboard` or `Users`) above the text — no custom illustration needed
- Add a prominent "Create your first group" CTA button that opens the group creation form inline
- Professional tone, not playful

### 10. Board columns don't communicate status-change actions

No drag-and-drop exists — cards move via small buttons. The visual design doesn't communicate this.

**Fix:** Make action buttons more prominent (ties into touch target work in #2). Status flow is: Open → In Progress → Done, shown via clearly labeled buttons.

---

## Minor Issues

### 11. `Link` icon from lucide shadows Next.js `Link`

`page.tsx:4` imports `Link` from lucide — this shadows the Next.js `Link` component name. Not a visual issue but a maintenance trap.

**Fix:** Rename the import to `LinkIcon`.

### 12. No explicit system font stack

`globals.css:102` applies `font-sans` but no custom `font-family` is defined. For a PWA aiming for native feel, explicitly set the system font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto`.

### 13. No loading skeleton for the board

`Board.tsx:55-61` shows "Loading tasks..." text. A skeleton with card-shaped pulse blocks would prevent layout shift.

**Decision:** Use shadcn's pulse animation style (default `Skeleton` component).

### 14. Description truncation is crude

`TaskCard.tsx:64-66` does `slice(0, 120) + "..."` — this can cut mid-word.

**Fix:** Replace with CSS `line-clamp-2` and `overflow-hidden`.

### 15. No `overscroll-behavior` for PWA panels

The sidebar and board columns should have `overscroll-behavior: contain` to prevent pull-to-refresh and scroll chaining on mobile.

---

## Priority Ranking

| Priority | Issue | Effort | Decision |
|---|---|---|---|
| P0 | #1 Responsive layout (drawer + tabs + rail) | Large | Decided |
| P0 | #2 Touch target sizing | Small | Decided |
| P1 | #3 ARIA roles on board | Medium | Decided |
| P1 | #4 ARIA on sidebar | Small | Decided |
| P1 | #5 Safe area insets for PWA | Small | Straightforward |
| P2 | #6 Dark mode card contrast | Small | Decided |
| P2 | #9 Empty state / onboarding | Medium | Decided |
| P2 | #13 Loading skeletons | Small | Decided |
| P3 | #7 Header improvements | Medium | Decided |
| P3 | #8 Connecting state | Small | Straightforward |
| P3 | #10 Action button discoverability | Small | Ties into #2 |
| P3 | #11 Link icon rename | Trivial | Straightforward |
| P3 | #12 System font stack | Trivial | Straightforward |
| P3 | #14 CSS line-clamp | Trivial | Straightforward |
| P3 | #15 overscroll-behavior | Trivial | Straightforward |

The P0 items (responsive layout and touch targets) are the most impactful — without them, the app is essentially desktop-only despite being a PWA.
