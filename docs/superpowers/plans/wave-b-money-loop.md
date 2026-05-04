# Wave B — Close the Money Loop

**Goal:** End-to-end working flows for invoicing, payment confirmation, AI-driven scheduling, and dispatcher manual scheduling. After Wave B merges, a tenant should be able to: (1) issue an invoice, (2) the customer pays via Stripe Elements, (3) the dispatcher sees the "paid" badge live, (4) the AI proposes a non-conflicting appointment that lands on the dispatch board, and (5) the dispatcher drags appointments to reassign them.

**Pre-Wave-B requirements** (Wave A — must merge first):
- **PR #195** — recovery migrations (045/046/049/050). Without this, P0-022 / P0-034 / P0-021 code crashes at runtime; Wave B will inherit the same broken state.
- **#194 vs #195 collision** resolved (both touch migration 045). Land #195 first; rebase #194's migration to 051.
- **P0-023** (Wave 1C wiring) — without this, the new Pg repos in `app.ts` are dead code. Wave B's payment-status query and dispatch-board appointment reads still hit the InMemory implementations otherwise.
- **P0-033** (Clerk RS256/JWKS) — without this, no real production user can authenticate. All the Wave B UX is invisible to real customers.

If any of those four are not green, **dispatch Wave B against staging only** until they land.

## Wave B story set

| Story | Layer | Story body | Dispatch addendum |
|---|---|---|---|
| **P5-017** | Payments / API | `phase-5-gap-stories.md` | `p5-dispatch-addendum.md` |
| **P5-016** | Payments / Web | `phase-5-gap-stories.md` | `p5-dispatch-addendum.md` |
| **P5-018** | Payments / Web + API | `phase-5-gap-stories.md` | `p5-dispatch-addendum.md` |
| **P0-035** | AI / Scheduling | `phase-0-gap-stories.md` | `p0-dispatch-addendum.md` |
| **P6-025** | Dispatch UI | `phase-6-gap-stories.md` | `p6-dispatch-addendum.md` |

P5-019 (invoice delivery notification) is **already largely covered by PR #194** (Twilio/SendGrid send). Re-evaluate after #194 lands; this Wave B plan does NOT include a separate P5-019 dispatch.

## Dispatch order (with parallelism)

```
                ┌──────────────────────────────┐
                │ Pre-Wave-A merges land first │
                │ (#195, P0-023, P0-033)       │
                └────────────┬─────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
            ┌──────┐      ┌──────┐       ┌──────┐
   wave B1  │P5-017│      │P0-035│       │P6-025│  ← parallel (3 agents)
            └──┬───┘      └──┬───┘       └──┬───┘
               │             │              │
               ▼             │              │
            ┌──────┐         │              │
   wave B2  │P5-016│  parallel-eligible after B1 P5-017 lands
            └──┬───┘
               │
               ▼
            ┌──────┐
   wave B3  │P5-018│  sequential — needs P5-016 backend endpoint
            └──────┘
```

**B1 — three agents in parallel** (no inter-dependencies):
- **P5-017** (mock payment provider production guard) — security, ~30 min agent
- **P0-035** (AI slot-conflict pre-check) — backend AI task layer, ~1.5 hr agent
- **P6-025** (drag-drop on DispatchBoard) — frontend UX, ~2 hr agent

**B2 — one agent after P5-017 merges:**
- **P5-016** (Stripe Elements in `InvoicePaymentPage`) — frontend, ~2 hr agent. Sequencing after P5-017 is conservative — they don't share files, but P5-017 sets the env-var contract that P5-016 reads (`STRIPE_PUBLISHABLE_KEY` precedence). If we want B1+B2 fully parallel, the agent for P5-016 must be told to read the publishable key from `import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY` and throw if missing — same pattern as `VITE_CLERK_PUBLISHABLE_KEY` in P0-029.

**B3 — one agent after P5-016 merges:**
- **P5-018** (live payment confirmation in dispatcher UI) — needs the `POST /api/payments/create-payment-intent` endpoint that P5-016 introduces, plus the SSE/poll wiring on `InvoicePaymentPage`. Cannot run in parallel with P5-016.

**Total wall-clock:** ~3 wall-clock waves; ~6 hours of agent time bundled into ~2.5 hours of dispatcher time given parallelism.

## What each story delivers

### P5-017 — Mock payment provider production guard

**Why:** the current `MockPaymentLinkProvider` will cheerfully run in production and return synthetic payment URLs. A production deploy without `STRIPE_SECRET_KEY` would silently take fake payments.

**Outcome:** factory fails closed in prod-mode; mock only available when `NODE_ENV !== 'production'` AND `STRIPE_SECRET_KEY` is missing. Verification gate includes a grep that prevents any unguarded `new MockPaymentLinkProvider()` from sneaking back.

### P5-016 — Stripe Elements in InvoicePaymentPage

**Why:** the customer-facing payment page today is a hand-rolled card form with a `setTimeout` fake submit. No real card data is processed; PCI surface is "all of our servers" (the worst possible answer).

**Outcome:** `<Elements>` provider wraps the page; `<PaymentElement>` handles card data (never touches our server); `stripe.confirmPayment()` with the client secret from `POST /api/payments/create-payment-intent`. PCI surface drops to zero.

### P5-018 — Payment confirmation flow to frontend

**Why:** today there's no way for the dispatcher (or the customer) to see "paid" in the UI without a manual refresh. Stripe webhook updates the DB; UI never knows.

**Outcome:** `useInvoiceStatus` hook polls (or SSE) the new `GET /api/invoices/:id/status` endpoint with the view-token. On `paid`, the UI flips to a success state. Tenant-scoped, view-token-gated, no auth required (public payment page).

**Risk:** websockets are out for v1 (Railway support + cost). 5-second poll OR SSE — pick whichever the agent finds cleanest given the existing routes infrastructure. Document the choice.

### P0-035 — AI slot-conflict pre-check (re-scoped)

**Why:** the original audit asked for a `create_appointment` proposal contract; investigation showed it already exists end-to-end. The actual gap is: today the AI proposes appointments without checking if the slot is busy. Dispatchers waste time rejecting obvious conflicts.

**Outcome:** new `SlotConflictChecker` module called from `create-appointment-task.ts`. On conflict, the task emits a `voice_clarification` proposal (not a `create_appointment`) so the user is asked to pick another slot up front.

**Risk:** failure-open semantics — if the conflict-query DB call throws, surface a clarification rather than crash the task. Don't lose user intent to a transient DB blip.

### P6-025 — Drag-and-drop on DispatchBoard

**Why:** the dispatch board is currently read-only. To move an appointment, a dispatcher has to find it, click edit, change the time, save. Drag-drop is the daily workflow that makes dispatchers productive.

**Outcome:** drag-and-drop wires to the existing `reassign_appointment` / `reschedule_appointment` / `cancel_assignment` proposal contracts. Drop creates a proposal (not a direct mutation); the appointment stays in its source position until the proposal is approved. Confirmation dialog before proposal creation.

**Risk:** mobile fallback (touch sensors), keyboard accessibility, and the "no direct mutation" invariant are all eyes-required at review time.

## Risks across the wave

1. **App.ts touch points.** P5-017 modifies `app.ts` (provider factory); P5-016 does not; P5-018 may add an SSE endpoint registration. P0-023 (Wave 1C wiring) also touches `app.ts`. **Order matters:** P0-023 → P5-017 → P5-018. Don't dispatch P5-017 until P0-023 has merged or its diff is being held.

2. **Migration collision.** Wave B does NOT add new migrations. `dispatch_analytics`, `delay_notice_state`, `platform_admins`, `webhook_events` indexes, and `diff_analyses.id` ALTER are all owned by the recovery PR (#195). If anyone in Wave B feels they need a migration, surface it — almost certainly the right answer is "no migration; consume the existing schema."

3. **Stripe test-mode credentials.** The reviewer for P5-016 / P5-018 will need a Stripe **test-mode** account configured in CI. If CI doesn't have it, the agent's tests must mock `@stripe/stripe-js` end-to-end. Default to mocked unless the user confirms test-mode wiring is present.

4. **Frontend auth assumption.** P5-016 / P5-018 are public-customer pages — the agent must NOT add `requireAuth` middleware to the new endpoints. View-token gating only.

5. **Codex / Gemini reviewer fan-out.** The PR fan-out from this wave will trigger automated reviewers across 5 PRs. Plan for review noise; if anything looks like the migration-eating pattern from PR #193, hold the merge until investigated.

## Verification surface (post-Wave-B)

| Path | Manual check | Owner |
|---|---|---|
| Issue invoice → email/SMS sent → customer opens → pays via Elements → "paid" appears in dispatcher UI within 10 s | end-to-end Playwright or manual | post-merge QA |
| AI voice "schedule John for Tuesday at 2 pm" → no conflict → `create_appointment` proposal queued → approved → appointment on board | scripted voice run | post-merge QA |
| AI voice "schedule John for Tuesday at 2 pm" but tech is already booked → `voice_clarification` proposal queued ("Tech is busy at that time, want a different slot?") | scripted voice run | post-merge QA |
| Dispatcher drags appointment from Tech-A's lane to Tech-B's lane → confirmation dialog → approve → proposal queued → approve in inbox → board updates | manual | post-merge QA |
| Production-mode startup with no `STRIPE_SECRET_KEY` → process throws with a clear "STRIPE_SECRET_KEY is required in production" message | startup smoke test | P5-017 acceptance |

## Out of scope for Wave B (deferred)

- **Wave C (customer reply loop):** estimate hosted view, accept/decline, customer-followup agent reply handling, Twilio inbound SMS webhook.
- **Refund flow** (P9 invoice agent v2).
- **Multi-currency invoices** (P9 v2).
- **Calendar integration** (Google/iCal sync) — separate phase.
- **Technician availability calendar** — P0-035 only checks for conflicts against existing appointments; it does not consult a separate availability calendar (lunch breaks, time-off requests, etc.). A future story can extend the checker.

## Coordinator runbook

When you're ready to dispatch Wave B:

1. **Verify pre-Wave-A**:
   ```bash
   git log origin/main --oneline | grep -E "P0-023|P0-033" | head -3
   gh pr view 195 --json mergedAt -q .mergedAt
   ```
   All three should report present/merged. If not, hold.

2. **Dispatch B1 in parallel** (3 stories, 3 worktrees):
   ```
   /dispatch-story P5-017
   /dispatch-story P0-035
   /dispatch-story P6-025
   ```
   These are independent. Run as parallel Agent calls.

3. **After P5-017 merges, dispatch B2:**
   ```
   /dispatch-story P5-016
   ```

4. **After P5-016 merges, dispatch B3:**
   ```
   /dispatch-story P5-018
   ```

5. **Manual QA pass** against the verification-surface table above.

6. **Update this doc's "Out of scope" → "Done" section** as items land.
