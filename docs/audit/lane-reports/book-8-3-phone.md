# §8.3 Book — phone-surface rung-5 reachability (ticket #1015, rows 3.1, 3.7, 3.10)

Branch: `cloud/book-8-3-phone`, off `origin/main` (2a68465). One commit per row. Run in Claude Code on the web (cloud sandbox), 2026-09-12/13.

Scope: TEST-ONLY, phone-surface leg of rows 3.1, 3.7 and 3.10 per #1015's dispatch table ("3.1, 3.6, 3.7, 3.10 (Sonnet) — hermetic reachability per #1004 for the phone rows"). No product code touched — `git diff --stat origin/main..HEAD -- packages/api/src packages/web/src packages/shared/src` is empty (verified below). `docs/PRD-v5-as-built.md` not edited. Never touched discount/tax math, `ai/supervisor/review-gate.ts`, or pricing code. **Only Fable states a new rung** — nothing here claims a row moves.

New files (all under `e2e/`, none under `packages/`):
- `e2e/fixtures/twilio-phone-lane.ts` — shared helpers (provisioning, signed POST, TwiML sid extraction, a dev-auth-bypass bearer token, a DB poll helper), copying `e2e/telephony-e1-signed-webhook.spec.ts`'s idioms exactly.
- `e2e/telephony-book-3-1-proposed-booking.spec.ts`
- `e2e/telephony-book-3-7-disambiguation.spec.ts`
- `e2e/telephony-book-3-10-book-move-cancel.spec.ts`

## Harness

```
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts   # -> DATABASE_URL

DATABASE_URL=<url> DB_SSL=false E2E_DEV_AUTH=0 E2E_USE_TEST_DB=true \
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000001 \
TWILIO_AUTH_TOKEN=deployment-fallback-token TWILIO_FROM_NUMBER=+15125550000 \
TWILIO_DEFAULT_TENANT_ID=00000000-0000-4000-8000-000000000001 \
TENANT_ENCRYPTION_KEY=<64 hex> PUBLIC_API_URL=http://localhost:3000 \
QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
npx playwright test <spec> --project=chromium --retries=0
```

Verified against the existing pattern spec first (smoke test, unmodified): `npx playwright test e2e/telephony-e1-signed-webhook.spec.ts --project=chromium --retries=0` → **6 passed**, confirming the DB/webServer/signing harness works before writing anything new.

PR #1082 (credential-owns-the-dialled-number binding) is **open, not merged**, at the time of this lane. All three specs below already sign each tenant's call with that SAME tenant's own `AccountSid`/token against its own DID (the E1 pattern spec's own convention) — the legitimate-traffic case that PR #1082 doesn't change, so nothing here depends on whether it has landed.

## Headline finding — read this before the per-row sections

**None of the three rows can complete on the phone surface without a real `AI_PROVIDER_API_KEY`, and this is a genuine, verified property of the code, not a fixture problem.** Investigated by reading the classifier/confirm/entity-resolution code, then confirmed empirically by driving the real routes (RED captures below).

1. **`matchNewBookingPhrase`** (`ai/orchestration/intent-classifier.ts:1859`) is a pre-LLM, anchored, entity-free regex short-circuit — needs no model — that classifies an opening like "I'd like to schedule a diagnostic visit" as `create_appointment` @ 0.95 confidence. It is NOT gated on `ownerSession`.
2. Classification success routes to `entity_resolution` (no entities here, so it resolves trivially) then unconditionally to `intent_confirm`, which reads the intent back ("Just to confirm — create appointment. Is that right?") — still no model call.
3. **The very next turn always needs a real model.** `confirmIntent` (`ai/skills/confirm-intent.ts`) classifies the caller's yes/no answer via `gateway.complete({taskType: 'classify_intent', ...})`. The hermetic no-key gateway (`scriptHermeticResponse`, `ai/providers/mock.ts`) only scripts that task type for `create_customer`/`draft_estimate`/`create_invoice` keyword matches; anything else — including a yes/no classification prompt — falls through to the generic `{intentType:'unknown', confidence:0.2}` catch-all, which has no `answer` field. `parseYesNo` returns `null`, and `confirmIntent`'s own "ambiguous → treat as a correction" safe default makes this **unconditional**: no spoken reply, literal "Yes, that is right" included, can ever confirm a booking under this harness. Verified empirically (RED, row 3.1 below).
4. **`reschedule_appointment` and `cancel_appointment` have NO deterministic short-circuit anywhere** — `grep -n "intentType: 'reschedule_appointment'\|intentType: 'cancel_appointment'" packages/api/src/ai/orchestration/intent-classifier.ts` returns zero matches, owner-gated (`OWNER_OPERATOR_COMMAND_PATTERNS`) or not. Every reschedule/cancel utterance goes to the real LLM classify call, which the hermetic mock answers as `unknown @ 0.2` — below `TAU_INT` — so these two never even reach entity resolution, let alone confirm.
5. **Disambiguation (`entity_ambiguous`) is wired for exactly one surface: the in-app/chat adapter** (`grep -rn "type: 'entity_ambiguous'" packages/api/src` → only `ai/agents/customer-calling/inapp-adapter.ts` and its `types.ts` declaration). Neither `telephony/twilio-adapter.ts` (classic Gather) nor `ai/voice-turn/create-voice-turn-processor.ts` (media-streams) ever dispatches it — both call the identical `resolveTurnEntities` → `resolveSchedulingEntities` pipeline and unconditionally fold whatever came back into `entity_resolved`, silently dropping an ambiguous multi-candidate result. This is independent of the AI-key finding above — it is a genuine, model-independent GAP on the phone surface, pinned as a characterization test (mirrors `e2e/telephony-e1-signed-webhook.spec.ts`'s "SECURITY GAP FOUND, NOT FIXED" / `test.fail()` convention).

Per the dispatch's own contingency ("If any step needs a real model … stop at the last reachable step, screenshot/TwiML the stop, and say exactly which seam needs a model"), every spec below reaches the deepest deterministic point, asserts on it, and documents the exact seam. No env var, SQL shortcut, or platform-admin action was used to get further — the model dependency is real.

---

## Row 3.1 — "a call produces a PROPOSED booking, not a booking"

**File:** `e2e/telephony-book-3-1-proposed-booking.spec.ts`. **Command:** the harness invocation above with that spec path.

**RED** (first version of the spec, asserting the row's literal claim — a drafted `create_appointment` proposal, approved through `/api/proposals/:id/approve`, producing an appointment):
```
1) … the call drafts a create_appointment PROPOSAL — no appointment exists until it is approved through the real inbox route
   Error: expect(received).toHaveLength(expected)
   Expected length: 1
   Received length: 0
   Received array:  []
     171 |     const proposals = await proposalsFor(tenantA.tenantId);
   > 173 |     expect(proposals.rows).toHaveLength(1);
```
Raw TwiML captured at that point showed the caller stuck in a low-confidence reprompt loop ("I want to make sure I got that right — can you say that again?") — tracing that led to the discovery in the headline section: turn 1 after `/voice` is always consumed by the FSM's `identifying` state (any speech advances it — confirmed by re-running with a throwaway first utterance and observing the identical "How can I help you today?" transition prompt regardless of content), so the deterministic booking-opener utterance has to be turn 2, not turn 1. Fixing turn order surfaced the SECOND, deeper wall (the `confirmIntent` model dependency in the headline section) via a second RED capture on the confirm turn itself: an earlier draft asserted the third turn's plain "yes" would confirm the booking; the live TwiML came back `"My apologies — let me try again. What would you like to do?"` every time, for any input — the diagnostic trail above pins the reason.

**GREEN** (final spec — reaches and proves the honest frontier): 2 tests, both passing.
```
✓  reaches the create_appointment intent readback deterministically, drafts NO proposal and books NO appointment — the confirm turn is the model-dependent seam (279ms)
✓  T2: tenant B's identical call reaches its OWN confirm readback independently, and neither tenant's empty proposal/appointment state is perturbed by the other (143ms)
```

**What's proven:** identify → `matchNewBookingPhrase` (model-free) → `create_appointment` readback ("Just to confirm — create appointment. Is that right?") — asserted directly on the real TwiML; zero `proposals` rows and zero `appointments` rows for tenant A at that point (the row's core "never silently books" claim, proven the strong way: nothing is EVER drafted while confirm can't succeed, not merely "not yet"); T2 — tenant B's identical call, its own DID/token, reaches its own confirm state independently, and tenant A's (empty) proposal state is unperturbed (`toEqual` on the snapshot).

**Not reached:** the confirmed proposal, its approval through `/api/proposals/:id/approve` (route read, confirmed reachable and correctly gated behind `requireAuth`/`requireTenant`/`requirePermission('proposals:approve')` — see the dev-auth-bypass token helper in the fixtures file, unused in the final spec once the confirm wall was found), and the resulting `appointments` row + `appointment.created` audit event. **Needs:** a real `AI_PROVIDER_API_KEY` so `confirmIntent`'s yes/no classification can actually answer "yes".

**Tenant grade:** T2 (two independently-provisioned, differently-DID'd tenants, each reaching the frontier on its own call, with a cross-tenant non-interference assertion).

---

## Row 3.7 — "the AI asks instead of guessing when two customers share a name"

**File:** `e2e/telephony-book-3-7-disambiguation.spec.ts`. **Command:** the harness invocation above with that spec path.

**Vehicle substitution, stated plainly:** `create_appointment` has no deterministic, entity-bearing short-circuit (`matchNewBookingPhrase` is entity-free BY ITS OWN DESIGN COMMENT), so no booking utterance can deterministically carry a customer name into entity resolution at all. `OWNER_OPERATOR_COMMAND_PATTERNS` (the only other deterministic, entity-bearing table) has no `create_appointment`/`reschedule_appointment`/`cancel_appointment` entry either. `create_job` is the nearest deterministic, entity-bearing, customer-naming WRITE intent reachable without a model on this surface — it is a `CUSTOMER_REF_INTENTS` member running through the IDENTICAL `resolveSchedulingEntities` pipeline `create_appointment` would use if it had a matcher, so the finding (see below) transfers directly to the booking case.

Two customers named "Jamie Rivera" seeded on tenant A, and one on tenant B, through the **real** `POST /api/customers` route (dev-auth-bypass bearer token minted for each tenant's own owner, per the fixtures helper) — not a direct SQL insert.

**RED** (the row's own literal assumption — the phone surface asks a disambiguation question):
```
✘ GAP (found on #1015, NOT fixed here): two same-named customers on tenant A never trigger a disambiguation question on the phone surface
  Error: expect(received).toMatch(expected)
  Expected pattern: /which .*(rivera|jamie)|more than one match/
  Received string:  "<?xml version=\"1.0\" encoding=\"utf-8\"?><response><say voice=\"polly.joanna\">just to confirm — create job. is that right?</say>…"
```

**Diagnosis, not guesswork:** `grep -rn "type: 'entity_ambiguous'" packages/api/src` → matches ONLY `ai/agents/customer-calling/inapp-adapter.ts` (+ its type declaration). Confirmed directly against Postgres too — `new PgEntityResolver(pool).resolve({tenantId, reference: 'Jamie Rivera', kind: 'customer'})` genuinely returns `{kind: 'ambiguous', candidates: [<id1>, <id2>]}` for the exact fixture (so this is not a seeding artifact), while the live phone call proceeds straight past it.

**GREEN** (final spec, characterizing the gap the same way `e2e/telephony-e1-signed-webhook.spec.ts` pins its security gap — a passing "GAP FOUND, NOT FIXED" test plus a `test.fail()` for the desired behavior): 3 tests.
```
✓  GAP (found on #1015, NOT fixed here): two same-named customers on tenant A never trigger a disambiguation question on the phone surface (264ms)
✘  DESIRED (currently FAILS, see the GAP above): the phone surface should ask a disambiguation question instead of silently dropping the ambiguity (152ms) — test.fail(), counted as passed
✓  T1: a same-named customer on tenant B is never a candidate for tenant A's ambiguous call (142ms)
```

**What's proven:** (1) direct resolver proof that Postgres genuinely reports ambiguity for the fixture; (2) the live call, through the real routes, proceeds straight to the ordinary confirm readback with NO disambiguation prompt and drafts NO proposal; (3) a `test.fail()` pin of the desired behavior — the day `entity_ambiguous` gets wired for telephony, this test starts passing and is the signal to promote the assertion and re-grade; (4) T1 — tenant B's own same-named customer is confirmed (via the same direct resolver call, scoped by tenant id) never to appear as a third candidate for tenant A's ambiguity, and tenant B's own independent owner-line call reaches its own confirm state with zero proposals, unaffected by tenant A's fixture.

**Not reached:** an actual spoken disambiguation exchange and "exactly one proposal names the right customer" — the row's full claim. **Needs:** product work (wiring `entity_ambiguous` for the phone transports) — explicitly out of scope for this test-only lane — not a model.

**Tenant grade:** T1 (a same-named customer on a second tenant, confirmed never a candidate, plus that tenant's independent call reaching its own state).

---

## Row 3.10 — "book, move and cancel by talking" (owner's line)

**File:** `e2e/telephony-book-3-10-book-move-cancel.spec.ts`. **Command:** the harness invocation above with that spec path. Owner session confirmed live in the server log for every call: `"phone actor resolved at session establishment" … "via":"owner_phone"`.

**RED** (the row's own literal assumption for the MOVE leg — a spoken reschedule reaches a real `reschedule_appointment` proposal):
```
✘ MOVE never even classifies deterministically — no reschedule_appointment short-circuit exists on this surface
  Error: expect(received).toContain(expected) // indexOf
  Expected value: "reschedule_appointment"
  Received array: []
```

**GREEN** (final spec — reaches and proves the honest frontier for all three legs plus tenant isolation): 4 tests, all passing.
```
✓  BOOK reaches the deterministic create_appointment readback; nothing is drafted (same model-dependent seam as row 3.1) (204ms)
✓  MOVE never even classifies deterministically — no reschedule_appointment short-circuit exists on this surface (89ms)
✓  CANCEL never even classifies deterministically — no cancel_appointment short-circuit exists on this surface (194ms)
✓  T1 with a neighbour: the neighbour tenant's identical owner-line calls reach the same frontier independently, and tenant A stays untouched (213ms)
```

**What's proven:** on the OWNER's own line (`owner_phone`, `isApproverPhone` via `resolveOwnerSession`) — BOOK reaches the identical `create_appointment` confirm readback row 3.1 reaches (same wall, same reason); MOVE and CANCEL are shown to fail at a SHALLOWER point than BOOK — asserted explicitly (`not.toContain('reschedule')` / `not.toContain('cancel')`, i.e. the classifier genuinely never named the intent at all, not merely failed to confirm it) — because neither intent has any deterministic classify path on ANY session type; zero `proposals` and zero `appointments` rows for any of the three legs; T1 — a neighbour tenant's identical owner-line BOOK and MOVE calls reach the same frontier independently and leave tenant A's (unrelated, already-empty) proposal state untouched.

**Not reached:** any of the three legs completing — approved proposal, appointment/reschedule/cancel row, and audit event, for BOOK, MOVE or CANCEL. **Needs:** a real `AI_PROVIDER_API_KEY` (BOOK's `confirmIntent` wall) and, additionally for MOVE/CANCEL, either a real model classify call or a new deterministic short-circuit in `intent-classifier.ts` (none exists today for either intent) — the latter would be product code, out of scope here.

**Tenant grade:** T1 (a neighbour tenant's identical owner-line calls, confirmed independent and non-interfering).

---

## G4 grep — tenant scoping evidence

```
$ grep -n "WHERE tenant_id = \$1" e2e/telephony-book-3-1-proposed-booking.spec.ts e2e/telephony-book-3-7-disambiguation.spec.ts e2e/telephony-book-3-10-book-move-cancel.spec.ts
```
Every DB assertion in all three specs reads `proposals`/`appointments` scoped by `tenant_id = $1` per-tenant; the T1/T2 assertions additionally snapshot-compare (`toEqual`) a tenant's OWN row set before/after the other tenant's independent call, not merely a fresh empty-count check.

## Judgment calls

- Used `create_job` (not `create_appointment`) as row 3.7's vehicle — explained above, and repeated in the spec's own header comment so it can't be missed on review.
- Row 3.7's disambiguation-answer half (a follow-up turn resolving the ambiguity) could not be attempted at all: since `entity_ambiguous` is never dispatched on this surface, there is no disambiguation state to answer into — pinning the absence itself (via the two-part GAP/DESIRED test pair) was judged more honest than fabricating a follow-up turn against a state the FSM never enters.
- Did not add `AI_PROVIDER_API_KEY` or any other env var beyond the harness's own list, per the dispatch's explicit "no env-var shortcut."
- Left `docs/audit/lane-reports/1015-book.md` (the existing Sonnet TEST-ONLY lane's own report) untouched; this is a separate file for the phone-surface leg only, per that report's own "Rows NOT in this lane: … 3.7/3.10 (Playwright reachability)" line.

## Not done

- The confirmed-proposal / approval / execution / audit half of all three rows — needs a live model.
- Row 3.7's actual disambiguation exchange — needs product work (wiring `entity_ambiguous` for telephony), explicitly out of scope for a test-only lane.
- Row 3.6 (technician double-booking, listed alongside 3.1/3.7/3.10 in #1015's phone-row grouping) — not in this branch; tracked separately.

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
Clean (no output).

```
git diff --stat origin/main..HEAD -- packages/api/src packages/web/src packages/shared/src
```
Empty — no product code touched.
