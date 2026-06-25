# U13 — Public / portal (customer-facing) → tenant-neutral Path A

- **Status:** ready to execute
- **Parent plan:** `docs/plans/2026-06-24-001-feat-web-redesign-path-a-plan.md` → unit **U13** (B9), OQ1 RESOLVED → tenant-neutral
- **Depends on:** U2 (tokens + kit primitives — already shipped; `index.css` tokens + `components/ui/*` exist)
- **Scope (two clusters — per the master plan's U13 `Files:` line, which lists both `components/customer/*` AND `pages/portal/*`):**
  - **Cluster A — public customer pages:** `packages/web/src/components/customer/{EstimateApprovalPage,InvoicePaymentPage,BookingPage,IntakeFormPage,FeedbackPage}.tsx` (the blue/indigo-heavy ones needing the brandmap override).
  - **Cluster B — authenticated portal:** `components/portal/PortalCard.tsx` + `pages/portal/{PortalShell,PortalDashboard,PortalInvoiceList,PortalEstimateList,PortalAgreementList,PortalJobList,PortalPaymentMethods,PortalRequestService,PortalBookAppointment,PortalSlotPicker}.tsx` + `pages/portal/__tests__/*`. **Verified: 0 blue/indigo across all of Cluster B** — these are already slate+semantic, so they need slate→neutral + semantic + kit-form migration only, NO blue→neutral override. Money via canonical `formatPortalCents`. `PortalPaymentMethods` has a Stripe SetupIntent seam → same "leave Stripe surface untouched" decision as §3.
  - Plus a new shared `portalNeutral.ts`. **No API/contract/data changes.** Presentational + form-primitive migration only.
  - **Scope-correction note:** an earlier draft of this plan enumerated only Cluster A (the Explore pass mis-pathed `PortalCard` and skipped `pages/portal/*`). The master plan's U13 `Files:` line includes `pages/portal/*`; shipping only Cluster A would be U13 ~60% done. Both clusters are executed here.

---

## 1. Why this cluster is different (the one decision that drives everything)

These are the only **externally-visible, tenant-representing** pages in the app. They render the
tenant's business (`businessName`/`estimateLabel` flow through the public view APIs), not ServiceOS.
Per OQ1 (resolved in the master plan): there is **no tenant-color mechanism** — `PortalCustomer`
carries only `companyName`; no `brandColor`/`logoUrl` exists, and `PortalCard.tsx`'s
"tenant-branded card" comment is aspirational. So the portal gets **shape + typography only**:
Path A neutrals and structure, **NOT Path A blue**.

**`--primary` (#1f5fd6) IS the ServiceOS brand blue.** Painting the portal with it would make a
tenant's quote read as a ServiceOS quote. Therefore this cluster **overrides the standard brandmap**
(`docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md`) in exactly two rules:

| Standard brandmap rule | **Portal override** |
| --- | --- |
| `blue, indigo → primary` | `blue, indigo → neutral` (foreground / secondary / border — never primary) |
| `bg-slate-900/800 → bg-primary` (dark CTAs) | dark CTAs → `bg-foreground` (**ink**, never primary) |
| `bg-accent` / `accent-foreground` (kit `outline` hover) | override to `bg-secondary` / `text-foreground` (accent is brand-tinted #e7eefb/#1a4fb5) |

Everything else in the standard map is unchanged: slate/gray/zinc → neutrals (foreground /
muted-foreground / secondary / border / card); **semantic status stays semantic** — green/emerald →
`success`, amber/orange/yellow → `warning`, red/rose → `destructive` (these are universal status
colors, not brand, and are legitimate on customer pages: confirmation green, error red, deposit amber).

---

## 2. Form controls: kit + **neutral focus override** (decision confirmed)

8 hand-rolled controls across 4 files migrate to the kit (`Input`/`Textarea` from `components/ui`).
**None of the customer pages currently import the kit.** The kit's defaults leak brand blue, so every
migrated control and CTA carries a neutral override. Centralize the overrides in one auditable module.

### 2.1 Where the kit leaks brand blue (verified against `components/ui/input.tsx` + `button.tsx`)

- `Input`/`Textarea`/`Select` `BASE_FIELD` always emits `focus-visible:ring-ring/30`; non-invalid
  state adds `focus:border-primary`. **Both are `--primary`/`--ring` = brand blue.**
- `Button` base always emits `focus-visible:ring-ring/50`; `variant="primary"` = `bg-primary`;
  `variant="outline"` hover = `bg-accent hover:text-accent-foreground` (brand-tinted).

`cn = twMerge(clsx(...))` (verified in `components/ui/utils.ts`) — so a `className` override of the
same color utility **reliably wins** (twMerge dedupes `border-color`/`ring-color`/`background-color`
conflicts within the same variant prefix). The override mechanism is sound.

### 2.2 New file — `packages/web/src/components/customer/portalNeutral.ts`

Single source of truth so every portal field/CTA is overridden identically and the guard has one
thing to enforce. Exact constants (token names verified against `index.css`):

```ts
// Tenant-neutral overrides for the customer/portal cluster. The shared kit
// (Input/Textarea/Button) defaults to --primary/--ring (the ServiceOS brand
// blue) on focus/fill; these pages represent the TENANT, not ServiceOS, so we
// strip brand blue down to neutral ink/secondary. See U13 plan + OQ1.

/** Kit Input/Textarea/Select on portal pages. Overrides focus border + ring to
 *  neutral ink, and guarantees the 44px tap target. */
export const NEUTRAL_FIELD =
  'min-h-11 focus:border-foreground focus-visible:ring-foreground/20';

/** Primary portal CTA (Accept / Pay / Submit / Continue). Ink fill, neutral ring,
 *  not bg-primary. Pair with kit <Button> (any variant — className wins). */
export const NEUTRAL_CTA =
  'bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80 ' +
  'focus-visible:ring-foreground/40';

/** Secondary/outline/ghost portal button — kills the brand-blue focus ring and
 *  the brand-tinted accent hover on variant="outline". */
export const NEUTRAL_BTN =
  'focus-visible:ring-foreground/40 hover:bg-secondary hover:text-foreground';
```

- **Ink CTA, not `bg-foreground`-only:** `text-background` (#f6f4ef) on ink (#16202e) is the
  inverted strong-action affordance with zero brand color. Verified both tokens exist light + dark.
- **Invalid fields:** `NEUTRAL_FIELD` (last in `cn`) overrides the destructive focus border/ring too,
  so an errored field focuses neutral while its **resting** `border-destructive/50` still signals the
  error. Acceptable for these simple lead/booking forms (rare invalid states); the red resting border
  is the error signal, the focus color is not.

### 2.3 Migration rules (per `preserve-aria-label-through-kit-form-migration.md`)

- **Keep `aria-label="<fieldKey>"` on each kit control**; put the human label in `<Field label>`.
  Tests query by `getByLabelText('<camelCaseKey>')` via `aria-label` → zero churn, zero a11y-name
  regression. Do **not** humanize the label or drop the `aria-label`.
- **One error surface:** don't pass `error` to `Field` if the form keeps a single top-level
  `role="alert"` (Field renders its own → `findByRole('alert')` throws on multiple).
- **44px:** every migrated control and any button a layout test asserts `min-h-11` on keeps
  `min-h-11` (kit `Button size="md"` is `h-10`=40px; `NEUTRAL_FIELD` bakes `min-h-11` for fields).
- **Bespoke composites stay native:** `SignatureCanvas` (transparent canvas + inline clear button)
  is not a text field — recolor its focus/border to neutral, do **not** kitify.

---

## 3. Stripe seam — **decision: leave the payment surface untouched**

`InvoicePaymentPage.tsx` mounts `<Elements>` with `appearance: { theme: 'stripe' }` (default).
**Keep it as-is.** Rationale: (a) the default Stripe theme is its own neutral surface — not ServiceOS
blue, so it's already tenant-neutral; (b) theming it couples us to the Stripe `appearance` API as a
second source of truth for color with no tenant-color input to feed it; (c) `InvoicePaymentPage` has
**0 blue/indigo leaks** today. The **Tailwind chrome around** the `PaymentElement` (card, headings,
totals table, buttons) still gets the neutral recolor. Document this inline with a one-line comment at
the `appearance` site so it's a deliberate choice, not an oversight.

---

## 4. Folded-in correctness fix (customer-facing money)

`EstimateApprovalPage.tsx` lines ~993 and ~1022 render tier/add-on prices as
`` `${(item.totalCents / 100).toLocaleString()}` `` — `.toLocaleString()` with no
`minimumFractionDigits` **drops the cents on round-dollar amounts** ($10.00 → "$10"). The file already
has `fmtUsd()` (lines 15–16) enforcing 2 decimals and used everywhere else. This is a money-display
defect on a customer-facing page (integer-cents-invariant-adjacent), and these are the exact lines the
`bg-blue-50` selection recolor touches. **Fix folded into U13b:** replace both with `fmtUsd(...)`;
during implementation `grep toLocaleString` in the file to catch any sibling occurrences. Pin with a
focused test asserting a round-dollar tier renders `"$X.00"`.

---

## 5. Units (one commit per file — reviewable, bisectable, per the migration doc)

> **Order:** U13a first (others import `portalNeutral`). U13b–U13f are independent of each other.

### U13a — Foundation: `portalNeutral.ts` + `PortalCard.tsx` recolor
- **Files:** new `components/customer/portalNeutral.ts`; `components/portal/PortalCard.tsx` (the shared
  card primitive used across Cluster B — **path is `components/portal/`, not `components/customer/`**)
  (+ `portalNeutral.test.tsx` smoke).
- **Do:** create the three constants (§2.2). Recolor `PortalCard` slate→neutral tokens
  (`bg-white→bg-card`, `border-slate-200/300→border-border`, `text-slate-500→text-muted-foreground`,
  `text-slate-700/900→text-foreground`). No behavior.
- **Verify:** grep `PortalCard.tsx` raw-palette-clean; tsc build; a 3-line `portalNeutral.test.tsx`
  asserting the constants contain no `primary`/`ring-ring`/`accent` substring (locks tenant-neutrality
  of the shared constants themselves).

### U13b — `EstimateApprovalPage.tsx` (biggest; 206 leaks, 11 blue/indigo)
- **Do:**
  - Recolor: slate→neutrals; green/red/amber→success/warning/destructive; **blue/indigo→neutral**:
    selected tier/add-on `bg-blue-50`→`bg-secondary`, selected radio/check `border-blue-600 bg-blue-600`
    →`border-foreground bg-foreground` (inner dot `bg-white`→`bg-card`/`bg-background`), step icons
    `bg-blue-100 text-blue-600` / `bg-violet-100 text-violet-600`→`bg-secondary text-foreground`
    (collapse — decorative), `focus:border-indigo-400`→handled by kit override.
  - Kit-migrate the 2 native controls: ApprovalSheet name `<input>` and DeclineButton reason
    `<textarea>` → `<Field><Input/Textarea aria-label=… className={NEUTRAL_FIELD}/></Field>`.
    `SignatureCanvas` stays native (neutral recolor only).
  - CTAs (Accept / Pay deposit / Download PDF / show-more) → kit `<Button className={NEUTRAL_CTA}>`
    (or `NEUTRAL_BTN` for secondary); **keep `min-h-11`** on show-more + Download PDF (layout test).
  - **Money fix** (§4): both `(…/100).toLocaleString()` → `fmtUsd(…)`.
  - Dark-CTA slate (`bg-slate-900`) → `bg-foreground` (ink), **never** `bg-primary`.
- **Tests — keep EXACTLY green** (no edits beyond what behavior demands):
  `EstimateApprovalPage.{layout,deposit,validity,error}.test.tsx`. The layout test pins
  `minmax(0,1fr)`, `min-w-0`, `break-words`, `tabular-nums` ×3 money cols, 4 cells/row, `min-h-11` on
  show-more + Download PDF, and the **Quote/Estimate label swap** — recolor touches only color tokens,
  so these structural classes are untouched by construction; the kit migration must preserve
  `min-h-11`. deposit test pins `"$250.00"` exact format — `fmtUsd` keeps 2-decimals.
- **Add:** `EstimateApprovalPage.contract.test.tsx` — class-contract guard (§6) + the round-dollar
  money assertion (§4).

### U13c — `InvoicePaymentPage.tsx` (102 leaks, 0 blue/indigo)
- **Do:** recolor Tailwind chrome only (slate→neutrals; amber/green/red→semantic). **Stripe
  `appearance` untouched** + add the one-line deliberate-choice comment (§3). CTAs → `NEUTRAL_CTA`.
  Money already via canonical `formatMoney`/`formatCurrencyAmount` — leave. *Optional polish:* add
  `tabular-nums` to the invoice totals money column for alignment parity (include only if it doesn't
  perturb the test; skip otherwise).
- **Tests:** keep `InvoicePaymentPage.test.tsx` green (all testid/behavior — Stripe Elements,
  processing_async/ACH banner, P5-018 polling, deposit-credit row `-$250.00`). **Add** class-contract
  guard. Note: guard must mount the non-Stripe chrome states it can (the `PaymentElement` is stubbed).

### U13d — `BookingPage.tsx` (52 leaks, 6 blue/indigo)
- **Do:** recolor; `focus:border-blue-400 focus:ring-blue-100`→kit `NEUTRAL_FIELD`; success-screen
  phone `text-blue-600 hover:border-blue-300`→`text-foreground underline hover:border-border`
  (neutral link). Kit-migrate 7 `<input>` (name/phone/email/street/city/state/zip) + 1 `<textarea>`
  → Field+Input/Textarea, `aria-label` keys preserved, `NEUTRAL_FIELD`. Submit/back CTAs neutral.
- **Tests:** keep `BookingPage.layout.test.tsx` (`min-h-11` on slot buttons, name input, postal input,
  back link, CTA) + `BookingPage.test.tsx` (slot→details→submit flow) green. **Add** class-contract
  guard (mount both the form state and the success state — multi-state coverage; see §6 caveat).

### U13e — `IntakeFormPage.tsx` (104 leaks, 13 blue/indigo)
- **Do:** recolor; `focus:border-blue-400 ring-blue-100` (×3)→kit override; business-hours hint box
  `bg-blue-50 border-blue-100`→`bg-secondary border-border`. **`URGENCY_OPTIONS` map stays semantic**
  (Emergency→destructive, ASAP→warning, Flexible→success — a real severity scale, like overdue/due;
  NOT a brand concern, NOT collapsed). Kit-migrate 5 `<input>` + 1 `<textarea>` across wizard steps,
  `aria-label` keys preserved, `NEUTRAL_FIELD`; keep the single inline validation `role="alert"`
  (don't pass `error` to Field). Wizard CTAs neutral.
- **Tests:** keep `IntakeFormPage.test.tsx` green (wizard flow, split-name, honeypot `_company_url`,
  attribution, displayName submit). **Add** class-contract guard — **must walk all wizard steps**
  (service → description → contact → review), since a jsdom guard only sees mounted states and the
  blue leaks live on steps 2–3 (the U8 lesson).

### U13f — `FeedbackPage.tsx` (45 leaks, 1 indigo)
- **Do:** recolor; `focus:border-indigo-400`→kit override on the comment `<textarea>` migration.
  Star buttons keep `p-1`, submit keeps `py-4` (≥44px). CTAs neutral.
- **Tests:** keep `FeedbackPage.test.tsx` green (star-rating testid, public-review CTA gating ≥4,
  tap targets). **Add** class-contract guard (mount the rating state and the post-submit state).

---

## 5b. Units — Cluster B (authenticated portal; **0 blue/indigo → no override, just neutral+semantic+kit**)

> All Cluster B pages already use slate + semantic + canonical `formatPortalCents`. They need the
> standard neutral/semantic recolor (NO blue→neutral override — there's no blue to remap), the kit
> form migration with `NEUTRAL_FIELD`, and the §6 guard. Existing tests in `pages/portal/__tests__/`
> stay green. Depends on U13a (`portalNeutral`, `PortalCard`).

### U13g — `PortalShell.tsx` + `PortalDashboard.tsx`
- **Do:** recolor the shell frame (nav/header/tab chrome) and dashboard slate→neutrals;
  due-amount/status tints→semantic. Keep the "tenant brand shows through" comment honest — it's
  accurate (businessName flows through); leave it. CTAs → `NEUTRAL_CTA`/`NEUTRAL_BTN`. Dashboard
  money via `formatPortalCents` — leave.
- **Tests:** keep `PortalDashboard.test.tsx` green. **Add** class-contract guard for both
  (PortalShell has no test → guard is its only coverage; render its mounted chrome).

### U13h — Portal list pages: `PortalInvoiceList`, `PortalEstimateList`, `PortalAgreementList`, `PortalJobList`
- **Do:** recolor each (low leak counts: 5–10). Status pills→semantic; money via `formatPortalCents`
  (leave). These render `PortalCard` (recolored in U13a) — verify the composed result is neutral.
- **Tests:** keep `PortalInvoiceList/PortalEstimateList/PortalAgreementList.test.tsx` green
  (`PortalJobList` has no test → guard-only). **Add** class-contract guard per file.

### U13i — Portal form pages: `PortalRequestService`, `PortalBookAppointment`, `PortalSlotPicker`
- **Do:** recolor; kit-migrate the controls (RequestService 4, BookAppointment 1, SlotPicker 2) →
  Field+Input/Textarea/Select, `aria-label` keys preserved, `NEUTRAL_FIELD`, `min-h-11`. Slot buttons
  keep `min-h-11`. CTAs neutral.
- **Tests:** keep `PortalRequestService.test.tsx` green (BookAppointment/SlotPicker have no test →
  guard-only). **Add** class-contract guard per file (walk multi-step/slot states).

### U13j — `PortalPaymentMethods.tsx` (Stripe SetupIntent seam)
- **Do:** recolor Tailwind chrome only (16 leaks). **Leave the Stripe `<Elements>`/`appearance`
  surface untouched** (same rationale as §3) + add the one-line deliberate-choice comment. Add-card /
  save CTAs → `NEUTRAL_CTA`.
- **Tests:** keep `PortalPaymentMethods.test.tsx` green. **Add** class-contract guard (mount the
  saved-cards list + the add-card states reachable without a live Stripe).

---

## 6. Verification protocol (every unit)

1. **Source grep is the authority** (jsdom guards only see mounted states):
   ```bash
   grep -rnE '(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}' <file>   # → empty
   grep -nE '/[0-9]+/[0-9]+|/100\b' <file>   # → no mangled opacity artifacts
   grep -nE '\b(bg|text|border|ring)-primary\b|\bring-ring\b|\b(bg|text|border)-accent\b|accent-foreground' <file>   # → empty (tenant-neutral; primary-foreground excluded — portal has no primary surface)
   ```
2. **Class-contract guard** (regression tripwire), per file, full prefix set **plus** the portal
   brand-blue assertion — and **`ring-ring`/`bg-primary` ARE in static `innerHTML`** (Tailwind
   variant classes always live in the `class` attribute), so this guard genuinely catches a missed
   kit override in any state it mounts:
   ```ts
   const html = container.innerHTML;
   expect(html).not.toMatch(/(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/);
   expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);   // no ServiceOS brand blue
   expect(html).not.toMatch(/\bring-ring\b/);                       // no kit default focus ring
   expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/); // no brand-tinted accent
   ```
   For multi-state pages (U13d/e/f) render and assert across the states (form/success, each wizard
   step) — not the entry screen only.
3. **Build (mandatory):** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` is the
   API gate; for web run `cd packages/web && npx tsc --noEmit` and the file's vitest suite.
4. All pre-existing tests for the file stay green with **no assertion edits** (behavior/layout/money
   unchanged). If a test needs editing to stay green, stop — the change wasn't neutral.

---

## 7. Risks / watch-items

- **R1 — kit override forgotten on a field/CTA → brand blue leaks on focus.** Mitigated by: single
  `portalNeutral` constants (one import per call site), the §6 guard catching `ring-ring`/`bg-primary`
  in `innerHTML`, and the source grep. The guard's blind spot is unmounted states → §6.2 multi-state
  rendering for U13d/e/f.
- **R2 — recolor perturbs a layout-test structural class.** Won't happen if the edit only swaps
  `-(color)-NNN` tokens; the grid/`minmax`/`min-w-0`/`break-words`/`tabular-nums`/`min-h-11` classes
  carry no color and must be left byte-identical. Kit migration is the one place that can drop
  `min-h-11` — `NEUTRAL_FIELD` bakes it; assert it on the migrated control.
- **R3 — Quote/Estimate label swap.** Driven by `estimateLabel` text from the public view API
  (rendered as the "QUOTE" badge + "Accept this quote" CTA in `EstimateApprovalPage`). Pure text — do
  not touch; the layout test pins it. No styling variant exists or is added.
- **R4 — money format regression.** `fmtUsd` (2-decimal) is the only formatter for the touched lines;
  the deposit test's `"$250.00"` exact match is the tripwire. New round-dollar test in U13b.
- **R5 — `aria-label` accessible-name break on kit migration.** Mitigated by keeping
  `aria-label="<fieldKey>"` (the documented pattern); `getByLabelText('<key>')` stays green.

## 8. Out of scope (do not do here)
- No tenant `brandColor`/`logoUrl` mechanism (doesn't exist; OQ1 says neutral, not "build theming").
- No Stripe `appearance` theming (§3).
- No API/contract/public-view changes; no data wiring.
- No Path A **blue** anywhere in the cluster.
