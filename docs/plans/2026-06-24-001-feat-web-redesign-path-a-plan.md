# feat: Web App Redesign — Path A Brand + Prototype Flows (semantic-class migration)

**Created:** 2026-06-24
**Depth:** Deep (comprehensive)
**Status:** plan
**Branch:** `claude/gallant-hypatia-eubvga` (PR #624)
**Companions:** master plan `docs/plans/2026-06-23-001-feat-prototype-redesign-both-apps-plan.md` (R5),
`docs/solutions/architecture-patterns/brand-rebrand-via-semantic-token-swap.md`,
`docs/solutions/architecture-patterns/share-server-taxonomy-subset-parity-test.md`

## Summary

Bring `packages/web` (React + Vite + Tailwind v4, shadcn-style kit) to the Path A brand
and the prototype's flows. The mobile redesign already shipped these patterns; web now
mirrors them on wide desktop layouts (no separate desktop comps exist — adapt + extrapolate).

## Problem Frame

The brand **color tokens** landed in `packages/web/src/index.css` (Phase 0.1), but the web
app **does not render in brand** because the app + UI kit hardcode raw Tailwind palette
classes — **6,047 `(bg|text|border|ring)-(slate|blue|green|…)-NNN` occurrences across 182
files** (measured). `components/ui/button.tsx`'s `primary` variant is literally
`bg-slate-900 text-white`, not `bg-primary`. So today web is monochrome slate with blue
accents regardless of the tokens. Mobile shipped fidelity because it uses semantic classes
(`bg-background`, `text-primary`, `text-success`) end-to-end; web bypasses them.

**This redesign is therefore a semantic-class migration (slate→token) of the kit + screens,
a shape/typography pass, and a screen re-flow — NOT a token swap.** The token-swap solution
doc applies to color *values*; it does not get web to fidelity because the markup bypasses
tokens. (Action item: that doc needs a caveat — true for semantic-class codebases like
mobile, false for palette-hardcoded ones like web. Capture via `/ce-compound` later.)

A second gap: web's `@theme` has **no `--success`/`--warning`** (only `destructive`). Mobile
defines them. The prototype's status/confidence semantics (high=success/calm, low=loud) need
these as utilities first — and in Tailwind v4 a `bg-success` utility only exists if
`--color-success` is declared under `@theme inline` (CSS-first; there is no `tailwind.config.js`).

## Requirements

- **R1.** Web's `@theme` gains `success`/`warning` (+ foreground) tokens; `bg-success` etc.
  generate as real utilities.
- **R2.** The UI kit (`components/ui/*`) renders in Path A via semantic tokens, with the
  shape/elevation/typography pass — **public API (variant names, sizes, props) unchanged** so
  no call site breaks.
- **R3.** The app shell (`components/layout/Shell.tsx`) + `/design` Showcase render in brand.
- **R4.** Every operator screen is re-flowed to the prototype patterns mirroring mobile
  (pending-approvals hero, confidence + countdown + safe "approve all eligible", list status
  badges + amounts, thread timestamps/avatars, grouped settings), wired to existing endpoints.
- **R5.** The web inbox's batch-approve eligibility **reuses the shared `isCaptureProposalType`**
  (never duplicates the capture list) composed with web's `overallConfidence === 'high'`.
- **R6.** Public/portal + onboarding + dispatch reach brand parity within their constraints
  (portal tenant-neutrality — see OQ1; dispatch BEM — see U15).
- **R7.** Tests migrate per-screen in lockstep; the `min-h-11` tap-target invariants, BEM
  state-class names, and the `index.css` source-string test selectors are **preserved**.

## Key Technical Decisions

- **Semantic-class migration, kit-first.** Land the brand vocabulary in the kit (U1–U2) before
  re-flowing screens (U5+); otherwise each screen hand-picks brand classes → drift. The kit's
  `button.primary: bg-slate-900 → bg-primary` is the single highest-leverage line (re-skins
  ~600 consumers). (Alternative: per-screen sweep with no kit pass — rejected: guarantees N
  inconsistent brand interpretations.)
- **Keep the kit API stable.** Only change class *bodies*, never variant/size/prop names —
  keeps the blast radius to visuals and avoids breaking the ~hundreds of call sites + variant
  tests.
- **Reuse the shared safe-lane taxonomy, not mobile's numeric gate.** Web exposes a 4-tier
  `overallConfidence` string (`payload._meta.overallConfidence`), not mobile's 0–1
  `confidenceScore`. Web eligibility = `isCaptureProposalType(type) && overallConfidence === 'high'`.
  Do **not** import mobile's `isBatchEligible` verbatim — it reads `confidenceScore` (undefined
  on web → `confidenceBand` null → fails closed). The server re-validates every id as backstop.
  (Alternative: duplicate the capture list on web — rejected: the parity-test doc's "worst kind
  of bug for a safety gate".)
- **Radii/elevation tuned on the preview deploy, not blind.** Changing `--radius` ripples
  `rounded-sm/md/lg/xl` app-wide and is **test-silent** (no test asserts `rounded-*`/`shadow-*`).
  It needs human eyes (the Railway PR preview + `/design` Showcase), not green tests. Keep the
  current `--radius` conservative initially; tune as a design-QA pass. (Mirrors the deliberate
  mobile decision to defer radii.)
- **Promote `hoursUntilExpiry` to `@ai-service-os/shared`** so web's inbox + dashboard render
  the same countdown as mobile (it's already pure/RN-free in `packages/mobile/src/proposals/proposalEvents.ts`).
  Optional but cheap; do it when U6 needs it.

## Scope Boundaries

**In scope:** foundation (tokens + kit + shell + status vocab), all operator screens, public/
portal, onboarding, dispatch, marketing — to brand parity + prototype flows, wired to existing
APIs.
**Non-goals:** no new server business logic; no proposal/approval semantics change (never
auto-execute; server re-validates batch); no kit API redesign; no new routes/screens beyond
re-skin + re-flow.
### Deferred to follow-up work
- Numeric `confidenceScore` in the inbox serialization (for literal cross-platform `isBatchEligible`
  reuse) — OQ2.
- Adding the caveat to `brand-rebrand-via-semantic-token-swap.md` (ce-compound).

## Repository invariants touched

- **Integer cents** — estimate/invoice builders (U8/U9) render money; reuse existing money
  formatters, never float.
- **Human-approval gate / never auto-execute** — U6 batch-approve sends only capture-class +
  high-confidence ids; the server re-validates each; the per-chain approve stays. No change to
  the 5s-undo machine.
- **RLS/tenant_id, audit events, LLM gateway, catalog resolver, entity resolver** — untouched
  (front-end-only redesign; all reads/writes hit existing endpoints).

## Implementation Units

### Phase A — Foundation (must land before Phase B)

### U1. Token layer: success/warning + shape axis
- **Goal:** Add `--success`/`--warning` (+ foreground) to `:root`, `.dark`, and `@theme inline`
  so `bg-success`/`text-warning` generate; document the radius/elevation axis decision.
- **Requirements:** R1
- **Dependencies:** none
- **Files:** `packages/web/src/index.css`
- **Approach:** Mirror the mobile token values (`success #1f8a5b`, `warning #b5642e`; dark
  variants). Add to both the `:root`/`.dark` custom-prop blocks AND `@theme inline` as
  `--color-success`/`--color-warning` (+ `-foreground`) — the v4 footgun is that the utility
  won't exist without the `@theme` entry. Keep `--radius` as-is for now (note the 18px-card
  target as design-QA on the preview).
- **Patterns to follow:** the existing `--destructive`/`--color-destructive` two-layer wiring
  in the same file; mobile `src/theme/tokens.js` values.
- **Test scenarios:** `Test expectation: none — token/CSS scaffolding; verified by the web build
  compiling and `bg-success` generating (eyeball on /design).` Existing
  `styles/dispatch-conversation-styles.test.ts` must still pass (no BEM selectors touched).
- **Verification:** `npx vite build` succeeds; `bg-success`/`text-warning` appear in the built
  CSS.

### U2. UI-kit semantic + shape pass
- **Goal:** Migrate `components/ui/*` from slate/blue/red/green to semantic tokens + the
  shape/elevation/typography pass, API unchanged.
- **Requirements:** R2
- **Dependencies:** U1
- **Files:** `packages/web/src/components/ui/{button,badge,card,input,field,sheet,modal,stat-card,
  tabs,avatar,skeleton,spinner,progress,stepper,tooltip}.tsx`; tests
  `packages/web/src/components/ui/{primitives,sheet,modal,tabs}.test.tsx`.
- **Approach:** Rewrite `VARIANT_CLASSES`/`SIZE_CLASSES`/base strings to tokens
  (`bg-primary text-primary-foreground`, `bg-card`, `border-border`, `text-muted-foreground`,
  `bg-secondary`, `ring-ring`, success/warning tones for badge). `button.primary` → `bg-primary`.
  Keep every exported variant/size/prop name identical.
- **Patterns to follow:** mobile's tone language (high=success, warning=amber, danger=destructive,
  from `app/approvals.tsx` BADGE_TONE / `src/lib/entityStatus.ts`); the kit's own current prop
  shapes.
- **Test scenarios:**
  - Happy: each primitive still renders its variants (existing primitives/sheet/modal/tabs tests
    pass with class-body changes; update only assertions that pin a *color* string).
  - Edge: badge `success`/`warning` tones generate (add an assertion if the badge test enumerates
    variants).
  - Preserve: any `min-h-11`/size assertions on inputs/buttons stay.
- **Verification:** kit tests green; `/design` Showcase renders primitives in brand (preview).

### U3. App Shell + Showcase
- **Goal:** Re-skin the persistent chrome (sidebar, mobile top bar, logo/badge, mode toggle,
  nav active states) + the `/design` style guide to tokens.
- **Requirements:** R3
- **Dependencies:** U1, U2
- **Files:** `packages/web/src/components/layout/Shell.tsx`, `packages/web/src/pages/design/Showcase.tsx`;
  tests `packages/web/src/components/layout/Shell-mode.test.tsx` (behavior — should NOT need changes).
- **Approach:** slate→token across Shell; verify the pending-proposal badge + mode-aware nav
  still behave. Showcase becomes the single QA page for the brand.
- **Patterns to follow:** mobile `src/components/TabBar.tsx` token usage; existing Shell structure.
- **Test scenarios:** Shell-mode behavior tests (nav gating per role) stay green; no color
  assertions added.
- **Verification:** Shell renders in brand on the preview; mode/nav tests green.

### U4. Shared status vocabulary
- **Goal:** Re-skin the centralized status surfaces so many lists inherit at once.
- **Requirements:** R4
- **Dependencies:** U1, U2
- **Files:** `packages/web/src/components/shared/StatusBadge.tsx`,
  `packages/web/src/components/shared/AIProposalCard.tsx` (+ co-located tests).
- **Approach:** Map the 24-entry status color map to token tones (success/warning/destructive/
  neutral). AIProposalCard → tokens + confidence/countdown affordance vocabulary reused by U5/U6.
- **Test scenarios:** status→tone mapping unit-tested if a pure map is extracted; preserve any
  `min-h-11`.
- **Verification:** lists consuming StatusBadge show toned badges; tests green.

### Phase B — Screen re-flows (after Phase A; one commit per cluster, tests in lockstep)

### U5. Dashboard / Home (B1)
- **Goal:** Mirror mobile's pending-approvals hero + brand cards.
- **Requirements:** R4
- **Dependencies:** U2, U4
- **Files:** `packages/web/src/components/home/*` (HomePage + HfcrHeroCard, CoreKpisCard,
  PendingProposalsCard, MoneyLoopHomeCard, ActivityFeedCard, VoiceRoiCard, …) + co-located tests.
- **Approach:** `usePendingProposals()` already returns `{ count, proposals }` — build the hero
  with `proposals.slice(0,3)` + (shared) `hoursUntilExpiry`. slate→token throughout.
- **Patterns to follow:** mobile `app/index.tsx`.
- **Test scenarios:** **`CoreKpisCard.test.tsx` asserts `text-green-600`/`text-red-600`** — change
  to `text-success`/`text-destructive` OR (better) assert the `+/-%` text/`data-trend` and stop
  coupling to color. Preserve `min-h-11` on PendingProposalsCard/VoiceRoiCard.
- **Verification:** dashboard matches mobile dashboard intent; home tests green.

### U6. Inbox / Approvals + safe batch-eligible (B2)
- **Goal:** Confidence + countdown on rows + a global "Approve all eligible" reusing the shared taxonomy.
- **Requirements:** R4, R5
- **Dependencies:** U2, U4
- **Files:** `packages/web/src/components/inbox/InboxPage.tsx`, `ProposalChainCard.tsx`,
  `AmbiguityPicker.tsx` + co-located tests.
- **Approach:** import `isCaptureProposalType` from `@ai-service-os/shared`;
  `eligible = rows.filter(r => isCaptureProposalType(r.proposal.proposalType) && r.proposal.payload?._meta?.overallConfidence === 'high')`;
  render the hero ("N high-confidence eligible…") + confirm step reusing the existing
  `approveChain` batch transport with `eligible.map(id)`; keep per-chain approve. Confirm copy
  mirrors mobile honesty (money/comms/irreversible excluded).
- **Patterns to follow:** mobile `app/approvals.tsx`, `src/proposals/useApproveBatch.ts`; shared
  `proposal-action-class.ts`.
- **Test scenarios:** eligible filter excludes money/comms/irreversible + non-high; confirm posts
  only eligible ids; partial-failure + all-failed messaging; per-chain approve still works.
- **Verification:** web inbox mirrors mobile Approvals; the safety gate is capture+high only.

### U7. Customers list + detail (B3)
- **Files:** `components/customers/CustomersPage.tsx`, `pages/customers/{CustomerDetail,CustomerEdit}.tsx` + tests.
- **Approach:** migrate hand-rolled inputs/buttons to the kit; list rows → avatar initials +
  status/segment per mobile. **Dependencies:** U2.
- **Test scenarios:** `CustomersPage.test.tsx` behavior stays green (no color coupling); preserve a11y classes.

### U8. Estimates list + builder (B4)
- **Files:** `components/estimates/EstimatesPage.tsx`, `NewEstimateFlow.tsx`, `EstimateForm.tsx`,
  `pages/estimates/*` + tests. **Dependencies:** U2, U4. Consider splitting list vs builder into two commits.
- **Approach:** list rows → description + amount + status badge (mirror mobile); builder → kit
  fields, integer-cent money. **Heed `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`.**
- **Test scenarios:** line-item math (integer cents), good-better-best, convert-to-invoice behavior preserved.

### U9. Invoices list + detail (B5)
- **Files:** `components/invoices/InvoicesPage.tsx`, `pages/invoices/InvoiceDetail.tsx` + tests.
  **Dependencies:** U2, U4.
- **Approach:** status badge incl. derived overdue; Stripe link/deposit display → tokens; integer cents.

### U10. Jobs (B6)
- **Files:** `components/jobs/{JobDetail,TechJobView,JobsList}.tsx` + sheets + tests. **Dependencies:** U2, U4.
- **Approach:** JobDetail (largest file, ~233 occ) likely its own commit. **`TechJobView.test.tsx`
  uses `toHaveClass`** — update in lockstep. Preserve spinner classes.

### U11. Conversations / Messages (B7)
- **Files:** `pages/conversations/{CommsInboxPage,ConversationThread}.tsx`,
  `components/conversations/MessageBubble.tsx`, the conversation BEM block in `index.css` + tests.
  **Dependencies:** U2.
- **Approach:** thread timestamps/avatars per mobile `messages/[id].tsx`. **Convert the BEM hex
  in `index.css` to tokens WITHOUT renaming selectors** (the source-string test pins them).
- **Test scenarios:** `styles/dispatch-conversation-styles.test.ts` stays green (selectors +
  `min-height: 2.75rem` preserved); `CommsInboxPage` `querySelector` layout test preserved.

### U12. Settings (B8)
- **Files:** `components/settings/SettingsPage.tsx`, `TemplatesPage.tsx`, the ~20 `*Sheet.tsx` + tests.
  **Dependencies:** U2. Batch sheets by theme.
- **Approach:** grouped brand sections per mobile Settings. **`AIApprovalRulesSheet.test.tsx`
  asserts `border-indigo-500`** — re-point to `border-primary` or a `data-selected` attribute.

### U13. Public / portal — customer-facing (B9)  ⚠ see OQ1
- **Files:** `components/customer/{EstimateApprovalPage,InvoicePaymentPage,BookingPage,IntakeFormPage,
  FeedbackPage}.tsx`, `pages/portal/*` + `*.layout.test.tsx`/`*.deposit/.validity/.error.test.tsx`.
  **Dependencies:** U2.
- **Approach:** brand-sensitive money surfaces. **Resolve OQ1 first** (Path A vs tenant-neutral).
  Preserve the `.layout.test.tsx` grid/`break-words`/`min-h-11` invariants exactly; QA on real
  Stripe/signature flows. Do this cluster deliberately, not last-minute.
- **Test scenarios:** layout invariants preserved; approve/decline/pay/deposit behavior unchanged.

### U14. Onboarding (B10)
- **Files:** `components/onboarding/v2/OnboardingShell.tsx`, `Sidebar.tsx`, `steps/*` + tests.
  **Dependencies:** U2.
- **Approach:** slate→token; the `*.funnel.test.tsx` are behavior (analytics) not color — keep green.

### U15. Dispatch board (B11)  ⚠ bespoke BEM
- **Files:** `pages/dispatch/DispatchBoard.tsx`, `components/dispatch/*`, the dispatch BEM block in
  `index.css` + `TechnicianLane.test.tsx`/`AppointmentCard.test.tsx`/`styles/*`. **Dependencies:** U2.
- **Approach:** convert in-CSS hex (`#0f172a`, `#dbeafe`, …) to token vars **without renaming
  selectors**; decide whether to define the missing `.dispatch-board__*` rules or move to
  utilities; **keep the 2.75rem tap target**. BEM state-class names (`--drag-over`, `__status--*`)
  preserved (tests assert them).
- **Test scenarios:** BEM state tests + the `index.css` source-string test stay green.

### U16. Marketing (B12)
- **Files:** `components/marketing/*` (LandingPage, Pricing, Features, About, …) + `MarketingPages.layout.test.tsx`.
  **Dependencies:** U2. Public, brand-sensitive; preserve layout invariants.

### U17. Leads / Schedule / Interactions / Reports sweep (B13)
- **Files:** `pages/leads/*`, `components/schedule/SchedulePage.tsx`, `components/interactions/*`,
  `components/reports/*` + tests. **Dependencies:** U2, U4. Sweep-up of remaining mid-size screens.

## Risks & Dependencies

- **R-scope:** mis-read as a token swap → estimate off by an order of magnitude. Gate "done" on
  the `/design` Showcase + preview rendering in brand, not on tokens existing.
- **R-portal (OQ1):** applying Path A blue to the customer portal may conflict with its
  deliberate "tenant brand shows through" stance. Decide before U13.
- **R-dispatch:** bespoke BEM hex + source-string test + missing `.dispatch-board__*` rules.
- **R-tailwind-v4:** `bg-success` needs `@theme inline` entry (U1); arbitrary `bg-[#hex]` bypasses
  tokens — grep for stray brand hex after U2.
- **R-confidence-mismatch (OQ2):** never import mobile `isBatchEligible` verbatim (fails open/closed).

## Open Questions (resolve before the relevant unit)

- **OQ1 (before U13):** Does Path A apply to the customer portal/public flows, or do those stay
  tenant-neutral (shape + typography only, color tenant-driven)? Product decision.
- **OQ2 (follow-up):** Add numeric `confidenceScore` to the inbox serialization so web can reuse
  the shared `isBatchEligible` literally? Ticket, not a blocker.

## Sources & Research
- Explore inventory of `packages/web` (routes, kit, screens, tests) — 2026-06-24.
- Strategy memo (sequencing, reuse, test-coupling profile, risks) — 2026-06-24.
- Measured: 6,047 hardcoded-palette occurrences / 182 files; `@theme` lacks success/warning;
  `button.primary = bg-slate-900`.
