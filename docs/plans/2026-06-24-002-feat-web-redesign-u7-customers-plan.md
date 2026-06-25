# feat: Web redesign U7 — Customers list + detail + edit to Path A

**Created:** 2026-06-24
**Depth:** Standard
**Status:** plan

## Summary
Bring the Customers cluster (list, detail, edit, and the detail panels) onto the
Path A brand. Two changes: a behavior-safe semantic-token recolor of the seven
files that still carry raw Tailwind palette, and a structural migration of the
fully hand-rolled `CustomerEdit` form to the shared UI kit. This is the U7 unit
of the master web-redesign plan (`docs/plans/2026-06-24-001-feat-web-redesign-path-a-plan.md`),
expanded after research showed the cluster is 8 files / ~148 raw-palette
occurrences (not the 3 files the master line named).

## Problem Frame
The web app's brand tokens were never actually applied — the Customers screens
hardcode the raw Tailwind palette (`bg-slate-800`, `text-green-700`,
`bg-blue-50`…), bypassing the Path A tokens, so a token change alone does not
re-brand them. Separately, `CustomerEdit` is built from raw `<input>/<select>/
<textarea>/<button>` elements with ad-hoc `htmlFor`/`id` wiring, inconsistent
with the rest of the app (which uses the kit's `Input/Select/Textarea/Field/
Button`) and with the kit's focus/label/tap-target guarantees. Affects every
operator browsing or editing customers.

## Requirements
- R1. The Customers cluster renders in Path A — **zero** raw Tailwind palette
  classes remain in the eight touched files (grep-clean).
- R2. Service-type chips (HVAC/Plumbing/Painting) adopt one calm neutral token;
  per-type distinction is carried by the existing emoji + label (decision below).
- R3. `CustomerEdit` is rebuilt on the kit form controls (`Field` + `Input`/
  `Select`/`Textarea` + `Button`), recoloring it by construction and giving it
  the kit's consistent focus/label/error semantics.
- R4. No behavior regressions: all existing cluster tests stay green; the
  `CustomerEdit` form's accessible names, PUT submit, validation, and
  error-surface behavior are preserved exactly.
- R5. Public-UI hygiene: interactive controls on the edit form meet the ≥44px
  (`min-h-11`) tap-target rule; the recolor preserves existing a11y classes and
  `data-testid`s.

## Key Technical Decisions
- **Service-type chips collapse to a single neutral token** (`bg-secondary
  text-foreground border-border`) — *(user-confirmed)*. Service type is a
  category, not a status; the emoji (❄️🔧🎨) + label already differentiate, and
  Path A is deliberately calm. Mirrors how `StatusBadge` collapsed its 24-status
  rainbow into the tone set. (Alternative: three distinct brand-tinted hues —
  rejected because Path A only offers primary/success/warning/destructive, so
  mapping a non-status category onto, e.g., `warning` is semantically wrong and
  noisier.)
- **Migrate `CustomerEdit` to the kit now, not later** — *(user-confirmed)*.
  Matches the master-plan intent ("migrate hand-rolled inputs/buttons to the
  kit"), and the recolor of that file is throwaway work if the controls are
  about to be replaced. Doing it once avoids touching the file twice.
- **`CustomerEdit` owns its own recolor; U7a excludes it.** Because the kit
  components already use tokens, adopting them recolors the form for free. So
  the recolor unit (U7a) covers the other seven files and the migration unit
  (U7b) covers `CustomerEdit` end to end — neither file is touched twice.
- **Preserve the field-key accessible names** (`firstName`, `email`,
  `companyName`, `communicationNotes`, …). The existing test queries by
  `getByLabelText('firstName')`; the kit `Field` emits a real `<label htmlFor>`
  so these keep resolving **only if** the label text stays the field key.
  Humanizing labels ("First name") is a deferred copy pass, not part of U7.
- **Brand the list avatar.** The initials circle (`bg-slate-800 text-white`)
  becomes `bg-primary text-primary-foreground`, consistent with how the mobile
  Phase-2 list rows were branded. (Swapping it for the kit `<Avatar>` component
  is a deferred structural change — see Deferred.)

## Scope Boundaries
**In scope:** semantic-token recolor of `CustomersPage`, `CustomerDetail`,
`CommunicationTimeline`, `MergeCustomerPanel`, `ContactsPanel`, `TagsPanel`,
`CustomFieldsPanel`; the `SVC_CHIP` neutral-token decision; full migration of
`CustomerEdit` to the kit with its test updated.

**Non-goals:**
- No new customer status/segment badge — customers carry no status enum.
- No copy changes (labels stay as field keys; humanizing is deferred).
- No data/contract/API changes; presentational + structural only.
- `CustomerProfitCard.tsx` and `LanguageBadge.tsx` are already token-clean (0
  raw palette) — leave untouched.

### Deferred to follow-up work
- Surface customer `tags` (e.g. `VIP`) on list rows as a segment signal — a
  fidelity add the master line gestured at ("status/segment per mobile"); needs
  its own small unit.
- Replace the hand-rolled list/detail avatar circles with the kit `<Avatar>`
  component (U7a only recolors them).
- Humanize `CustomerEdit` field labels (copy + matching test-query update).

## Repository invariants touched
Presentational/structural only — no money math, mutations, AI paths, or
tenancy logic is changed.
- **Integer cents:** any money the cluster renders (e.g. `CustomerProfitCard`)
  keeps its existing cents formatting; U7 does not touch that file or its math.
- **Human-approval gate / audit / RLS / LLM gateway / catalog & entity
  resolvers:** not involved — the existing customer create/edit mutations are
  unchanged and continue to audit server-side. U7 swaps presentation only.

## Implementation Units

### U7a. Customers cluster recolor (seven files)
- **Goal:** Re-brand the Customers list, detail, and detail-panel components to
  Path A semantic tokens; collapse the service-type chips to the neutral token.
- **Requirements:** R1, R2, R5
- **Dependencies:** U2 (kit tokens — already landed)
- **Files:**
  - `packages/web/src/components/customers/CustomersPage.tsx` (~80 occ)
  - `packages/web/src/pages/customers/CustomerDetail.tsx` (~23)
  - `packages/web/src/components/customers/CommunicationTimeline.tsx` (~11)
  - `packages/web/src/components/customers/MergeCustomerPanel.tsx` (~10)
  - `packages/web/src/components/customers/ContactsPanel.tsx` (~5)
  - `packages/web/src/components/customers/TagsPanel.tsx` (~4)
  - `packages/web/src/components/customers/CustomFieldsPanel.tsx` (~2)
  - `packages/web/src/components/customers/CustomersPage.test.tsx` (extend — class-contract guard)
- **Approach:** Apply the established token map (the U5/U6a sed map: `slate/
  gray/zinc → secondary/muted/border/foreground`, `blue → primary`, `green →
  success`, `amber/orange → warning`, `red → destructive`, `white → card/
  primary-foreground`), then hand-fix the color-coded constructs the bulk map
  can't safely cover:
  - `SVC_CHIP` (CustomersPage:18–22): all three entries → `'bg-secondary
    text-foreground border-border'`.
  - List avatar initials (CustomersPage:257 `bg-slate-800 text-white`) →
    `bg-primary text-primary-foreground`.
  - Success-confirmation pulse (CustomersPage:379–380 `bg-green-100`) →
    `bg-success/15`.
  - Icon container (CustomersPage:244 `bg-amber-200`) → judge by meaning:
    `bg-warning/15` if it flags attention, else `bg-secondary`.
  - Drag handle (CustomersPage:137 `bg-slate-200`) → `bg-border`.
  - Filter/segment pill active vs. idle states (CustomersPage:319, 513, 533) →
    active `bg-primary text-primary-foreground`, idle `bg-card text-foreground
    border-border` (mirror the inbox/list pill pattern).
  - `CommunicationTimeline` channel/direction tints → collapse to neutral/
    primary tokens (info=primary); `KIND_LABELS` is already color-free.
  - After each file, re-grep for mangled opacity tokens (`/[0-9]+/[0-9]+`,
    `/100`) as in U6a.
- **Patterns to follow:** U5 home recolor (`75a4dc92`), U6a inbox recolor
  (`b5a43cdd`) and its `/tmp/brandmap.sed` flow; `StatusBadge.tsx` tone
  collapse for the categorical-color decision.
- **Test scenarios:**
  - Class-contract guard (extend `CustomersPage.test.tsx`): render a customer
    row that has service types; assert the service chip element contains
    `bg-secondary` and **no** raw palette (`expect(chip.className).not.toMatch(
    /(bg|text|border)-(green|blue|violet|slate|amber)-\d{2,3}/)`), and that the
    initials avatar carries `bg-primary` (not `bg-slate-800`). Pins the two
    judgment recolors against regression.
  - Existing behavior: the rest of `CustomersPage.test.tsx` and every other
    cluster test (`CustomerDetail`, `CommunicationTimeline`, `MergeCustomerPanel`,
    `ContactsPanel`, `TagsPanel`, `CustomFieldsPanel`, `CustomerProfitCard`,
    `LanguageBadge`) stays green unchanged — confirmed none assert on color.
  - Test expectation for the six non-`CustomersPage` files: none beyond the
    existing suite — pure recolor, no color-coupled assertions.
- **Verification:** `grep -E '(bg|text|border|…)-(slate|gray|…|rose)-[0-9]'`
  over the seven files returns nothing; `tsc --noEmit` clean; full web suite
  green.

### U7b. CustomerEdit form → UI kit
- **Goal:** Rebuild the hand-rolled edit form on the kit form controls, gaining
  consistent focus/label/error semantics and tap targets, recolored by
  construction.
- **Requirements:** R1, R3, R4, R5
- **Dependencies:** U2 (kit). Independent of U7a (different file); sequence
  after U7a for a clean cluster commit order.
- **Files:**
  - `packages/web/src/pages/customers/CustomerEdit.tsx`
  - `packages/web/src/pages/customers/__tests__/CustomerEdit.test.tsx` (update)
- **Approach:** Replace each `<label>+<input>` pair with `<Field label="<key>">
  <Input … /></Field>`; the `preferredChannel` `<select>` → `<Select>`;
  `communicationNotes` `<textarea>` → `<Textarea>`; the Save/Cancel `<button>`s
  → `<Button>` (primary for Save, ghost/secondary for Cancel). Keep the
  `FormState`/`setField` reducer, the dirty/submit flow, the **PUT** to
  `/api/customers/:id`, required-field validation (`role="alert"` /required/),
  and server-error surfacing exactly as-is — this is a presentation swap, not a
  logic change. Preserve the field-key label strings so `getByLabelText('first
  Name')` etc. keep resolving via the kit `Field`'s generated `htmlFor`/`id`.
  Ensure inputs/select/textarea and both buttons render at ≥44px (`min-h-11`),
  adding the class where the kit default is shorter.
- **Patterns to follow:** `CustomerDetail.tsx` (already consumes the kit
  `Button`); the kit `Field` doc comment (wires `htmlFor`/`id`/`aria-
  describedby`/`invalid`); any existing kit-based form (e.g. settings forms) for
  `Field`+`Input` composition.
- **Test scenarios:**
  - Happy path (existing, must stay green): initial values populate
    (`getByLabelText('firstName')` = 'Alice', email, companyName); editing
    `firstName` then Save issues `PUT /api/customers/c-1` with the updated body
    and calls `onSaved('c-1')`.
  - Edge: clearing `communicationNotes` submits `communicationNotes: ''`.
  - Error/validation: empty required `firstName` + Save → `role="alert"` with
    /required/i and **no** network call; a server failure surfaces its message
    in `role="alert"`.
  - Kit semantics (new assertions): every field is reachable via
    `getByLabelText('<key>')` (proves `Field` label wiring); Save/Cancel are
    `getByRole('button')`; an input and the Save button carry `min-h-11`
    (tap-target contract); the `preferredChannel` `Select` changes update state
    and ride into the PUT body.
  - Integration: none beyond the mocked-client test — no DB/contract change.
- **Verification:** `CustomerEdit.test.tsx` green; `getByLabelText` queries
  unchanged from before (accessible names preserved); grep-clean of raw palette
  in `CustomerEdit.tsx`; `tsc --noEmit` clean; full web suite green.

## Risks & Dependencies
- **Accessible-name drift (highest risk).** If the kit migration humanizes
  labels, `getByLabelText('firstName')` breaks. Mitigation: keep field-key
  labels in U7b; humanizing is explicitly deferred.
- **Tap-target default.** The kit `Input` height wasn't confirmed to be ≥44px;
  U7b must assert and, if needed, add `min-h-11` rather than assume the default.
- **`SVC_CHIP` over-neutralization.** Collapsing to one token is intended, but
  if a row shows several service chips they'll look identical save for the
  emoji — acceptable per the decision; the class-contract test locks it so it's
  a deliberate, reviewed choice.

## Open Questions (deferred to implementation)
- Exact token for the CustomersPage:244 icon container (attention-flag vs.
  inert) — decide by reading its surrounding context at implementation time.
- Whether `CommunicationTimeline` encodes inbound/outbound direction by color
  today; if so, pick one accent (primary) + an icon rather than two hues.
