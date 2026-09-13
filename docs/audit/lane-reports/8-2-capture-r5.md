# §8.2 Capture — rung-5 reachability lane report (lane P / test/8-2-capture-r5)

Ticket: [#1014](https://github.com/joshrkay/Serviceos/issues/1014) · map [#995](https://github.com/joshrkay/Serviceos/issues/995)
Branch: `test/8-2-capture-r5`, cut from `origin/main` at `d5996cead`.
Scope discipline: **test-only.** No files under `packages/api/src` or `packages/web/src` were touched. `git diff --stat origin/main...` touches only `e2e/telephony-capture-2-*.spec.ts` (new), `e2e/fixtures/capture-8-2-lane.ts` (new), and this report. No rung is claimed anywhere — Fable states rungs.

Every row below was already at **4 / 4−** (real Postgres, audit rows, at least T1) via the earlier `#1014-A`/`#1014-B` lanes. What was missing, and what this lane adds, is **reachability**: the same capability driven through the REAL surface the persona uses — a self-signed Twilio-shaped webhook through `/api/telephony/voice`+`/gather` or `/webhooks/twilio/sms/:tenantId` — with a second (and where relevant, third/fourth) tenant in the same run.

**Environment note (not a product change, worktree-local only):** this worktree had no `node_modules` of its own (the monorepo's node_modules lives at the outer checkout, `/Users/joshuakay/Serviceos/node_modules`, and Node's CJS resolution walks up to find it fine, but Vite's dependency optimizer does not — it requires one at the project root). A symlink `node_modules -> ../../node_modules` at the worktree root fixes this; it is untracked (gitignored) and does not appear in this PR's diff. Separately, `packages/api/src/voice/voice-service.ts` fails to typecheck under `ts-node`'s default (non-transpile-only) mode on this Mac's installed toolchain (`Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>`, unrelated to this lane — the file has been untouched since PR #820); every run below sets `TS_NODE_TRANSPILE_ONLY=true` to boot the dev webServer, a harness-only flag, not a product or config change.

---

## Row 2.1 — a dialled number resolves its own tenant and greeting (T2)

**File:** `e2e/telephony-capture-2-1.spec.ts`

The tenant is resolved purely from the dialled `To` number (`resolveTenantIdByPhoneNumber`, reading `tenant_integrations.provider_data->>'phoneE164'`). **Correction made mid-lane:** the DEFAULT greeting template is NOT built from `tenant_settings.business_name` — it is a single static `TWILIO_BUSINESS_NAME` env value shared by every tenant (`app.ts:3611`); the only product-supported way a tenant's own words reach the greeting is `tenant_settings.voice_greeting` (a custom persona greeting, `buildTelephonyGreeting` branch 1, resolved per-tenant by `createVoicePersonaResolver`). This spec sets each tenant's own `voice_greeting` and asserts the `/voice` TwiML contains each tenant's own text, never the other's, corroborated by a `voice_sessions` row read back by `call_sid`.

## Row 2.2 — recording disclosure precedes capture; the consent ledger writes (T1, reachability leg only)

**File:** `e2e/telephony-capture-2-2.spec.ts`

`buildTwiML` splices `<Start><Record>` immediately after the first `<Say>` unconditionally — a single signed `/voice` POST proves the ordering structurally, and `commitRecordingConsent` fires right after, writing a `consent_events` row (`kind:'recording', state:'implicit', source:'voice'`). **Normalization note found while building this spec:** `consent_events.phone_normalized` (via `normalizeConsentPhone`) and the `customers.phone_normalized` generated column both keep a US country-code leading `1` (strip-non-digits-only) — a DIFFERENT convention from `leads.phone_normalized` (drops the leading 1), confirmed directly against a real row. Per the lane brief, the `audit_events` emission for this write lands separately on draft PR #1136 (not merged on this branch — confirmed no `recording_consent.granted` emitter exists here), so this spec does not assert an audit row for the grant, only the ledger write itself. T1: a shared caller number across two tenants writes two independent consent rows.

## Row 2.3 — known customer identified; non-NANP collision refused; stranger becomes a lead (T1)

**File:** `e2e/telephony-capture-2-3.spec.ts`

Three legs, one surface (`/api/telephony/voice`):
- **Known customer**: no dedicated "identified" audit event exists (`identify.greet_known`/`identify.greet_unknown` in `ai/i18n/en.ts` are dead strings, zero call sites) — the positive signal is `logInboundCallOnCustomerTimeline`, awaited inline inside `handleInbound` before the `/voice` response is built.
- **Non-NANP collision**: `isNanpKey` rejects a foreign-country-code caller sharing a US customer's trailing 10 digits before any tail-probe SELECT runs; the caller becomes a lead instead.
- **Stranger**: `findOrCreateLeadByPhone` creates exactly one `leads` row (idempotent on repeat calls) with `lead.created` audited.

T1: the same phone number is a known customer of tenant B and a stranger to tenant A in the same run.

## Row 2.4 — a stranger cannot reach owner-only capability; the interception is audited (T1)

**File:** `e2e/telephony-capture-2-4.spec.ts`

A fresh/unknown caller lands in FSM state `ask_caller` first (`transitions.ts` — `unknown_caller` on bootstrap), and `handleAskCaller` resolves the caller ENTIRELY BY PHONE (`findOrCreateCustomerByPhone`) — it never reads the turn's `SpeechResult` — so the first `/gather` always advances `ask_caller` → `intent_capture` regardless of content; only the SECOND `/gather` is the one the classifier actually sees. `isIntentAcceptedOnProfile` is the one gate: an intent absent from the caller profile's `PROFILE_INTENTS` set is intercepted to `unknown`/`intent_off_surface` before routing. `CALLER_INTENTS` excludes `create_invoice`; the hermetic mock deterministically classifies "please issue an invoice for this job" as `create_invoice` (confidence 0.9) with no live model. The interception is audited as `voice.intent_off_surface` (`entityType: voice_session`, `metadata: {intent, profile, confidence}`). Positive control: the same utterance from the tenant's own `owner_phone` resolves `ownerSession:true` → profile `owner_line` → never intercepted. T1: tenant B's own owner phone is a stranger to tenant A (intercepted) but the owner on tenant B's own line (never intercepted) — same phone number, opposite outcomes, gated purely by which tenant's `owner_phone` it matches.

## Row 2.5 — E1 life-safety (English path) — already reached; no new work in this lane

**File (unchanged):** `e2e/telephony-e1-signed-webhook.spec.ts` (merged via PR #1082/#1054-batch)

Already drives the English gas-leak path through the real signed `/voice`+`/gather` webhooks with T1 and the #1072 cross-tenant credential-binding fix. Re-run here (6/6 passed) to confirm it still holds on this branch. The Spanish clause remains parked on decision #1056 (pinned at the unit level, not this file) — not re-litigated here. Listed in this section only to confirm the phone-surface leg the lane brief asked about is already satisfied.

## Row 2.6 — vulnerability triage: owner flag control + call reachability (T3; grading pinned #1119-class)

**File:** `e2e/telephony-capture-2-6.spec.ts`

Reachable, deterministically: `PUT /api/settings/capabilities/voice_vulnerability_triage` writes a real `tenant_feature_flags` row and reads back correctly per-tenant (T3); a real signed `/voice`+`/gather` call reaches the hook's own call site for both tenants. NOT reachable hermetically: `gradeVulnerability` calls the LLM gateway for `taskType:'grade_vulnerability'`, which the hermetic mock has no branch for (falls to the generic zero-score catch-all) — `vulnerability-triage-hook.ts` never persists a zero-grade turn, so no `triage_events` row can ever be written without a live model. Pinned with `test.fail()` citing the exact seam. The audit-emission gap (`vulnerability_triage.recorded`) is out of scope per the lane brief (lands via draft PR #1136).

## Row 2.7 — a dropped call gets exactly one recovery SMS, stamped and audited (T3·T4)

**File:** `e2e/telephony-capture-2-7.spec.ts`

This codebase detects "dropped" from the Gather FSM's own terminal-outcome derivation, not a Twilio status callback: two consecutive empty-`SpeechResult` `/gather` turns trip the shared silence ladder (cap `MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2`), ending the call with outcome `'failed'` (one of exactly two `RECOVERY_OUTCOMES`). The row schedules unconditionally 60s out; the live 30s-tick worker sweep (`PROCESS_ROLE` defaults to `'all'`, so the worker runs unprompted; worst-case ~90s latency) sends via the built-in `InMemoryDeliveryProvider` (this repo structurally cannot construct a real Twilio/SendGrid provider outside `NODE_ENV=production/staging`, confirmed via `notifications/delivery-provider-factory.ts`). T3: tenant A and C flip `dropped_call_recovery` ON via the real owner route, tenant B stays OFF. T4: A and C are both due in the same sweep tick (`due:2, sent:2, skipped:1` observed directly in the server's own sweep-completed log line), each stamped under its own tenant; B's row stays scheduled-but-unsent for the life of the test. `test.setTimeout(200_000)` at the CLI — this spec genuinely waits out the real schedule (observed ~100-120s wall time per run), no clock mocking, no backdated `scheduled_for`.

## Row 2.8 — an MMS from an unknown number resolves/stores through the real webhook; ambiguous sender clarifies (T1); drafting itself is pinned

**File:** `e2e/telephony-capture-2-8.spec.ts`

`ingestCustomerMms` has no direct app.ts call site — it is invoked from `workers/mms-ingest-worker.ts`'s queue-driven worker, which tries the tech-photo pipeline first and falls through to the customer path on `ignored_non_tech`. A local ephemeral HTTP server stands in for the Twilio media host (`fetchMedia` does a plain authenticated `fetch(url)` with no host restriction) — real JPEG bytes, hermetic by construction. Reachable and proven: an unknown sender's MMS resolves/creates a customer by phone and stores the photo as a real `files` row; two customers sharing one phone number make the sender ambiguous → `voice_clarification` proposal + `customer_mms.clarification_raised` audit, never a draft (unaffected by the bug below, since the clarification branch returns before any vision call). T1: tenant B's own MMS resolves its own independent customer + photo, never touching tenant A's.

**Genuine hermetic-mock bug found and reported, not fixed (test-only lane):** `MmsEstimateTaskHandler.buildUserContent` (`ai/tasks/mms-estimate-task.ts`) embeds `JSON.stringify(input.context)` (starts `{"customerId":"<uuid>",...}`) directly into the LLM prompt text. Under this repo's hermetic boot (no `AI_PROVIDER_API_KEY`), `scriptHermeticResponse`'s `extractName` helper (`ai/providers/mock.ts`) falls back to grepping the first quoted substring when its name-flavoured regexes miss — and the first quoted substring in that JSON blob is the literal JSON KEY `"customerId"`, not a customer's name. Every hermetic MMS draft is therefore labelled `"Service estimate for customerId"`, never the plain `"Service estimate"` the mock's own doc comment claims — and no real tenant catalog will ever contain an item with that name, so `groundLineItemPricing` never clears the mock's `catalogItemId: null`, and the `draft_estimate` Zod contract (`catalogItemId: z.string().uuid().optional()` — optional accepts ABSENT, not `null`) rejects the payload. `MmsEstimateTaskHandler` returns `parse_failed/invalid_payload`; no proposal, no `customer_mms.estimate_drafted` audit, ever, under this hermetic boot — for ANY MMS body, since `input.context` always carries `customerId`. Reproduced in isolation (real Postgres, real `PgCatalogItemRepository`, the real hermetic gateway, no HTTP/queue at all) before writing this down, to rule out a webhook-layer cause. Naming a catalog item to literally match the buggy string would launder the bug into a passing assertion — not done. Pinned with `test.fail()` in a dedicated "KNOWN GAP" test; #1119-adjacent (needs a live model, whose real description would never echo a JSON key, or a `mock.ts` fix — neither in scope here).

## Row 2.10 — concurrent unclaimed texts collapse to one open thread (T1)

**File:** `e2e/telephony-capture-2-10.spec.ts`

The real dispatcher wires a `leadRepo` into the capture handler, so a genuinely unmatched number find-or-creates a `leads` row and threads onto `entityType:'lead'` (not the bare unmatched-phone shape the leadRepo-less vitest fixture exercises — the same migration-200 partial unique index covers both entity types). Two concurrent (`Promise.all`) signed SMS webhooks from one unclaimed number collapse to one open thread with both message bodies, `sms.inbound.captured` audited. T1: the identical number texting a second tenant produces an independent lead+thread pair.

## Row 2.11 — the negotiation guardrail refuses a below-floor discount, routing the owner a counter (T1)

**File:** `e2e/telephony-capture-2-11.spec.ts`

Fully deterministic, no LLM anywhere on this path: `parseDiscountTarget` is a pure regex parser; `evaluateNegotiationDiscount`/`evaluateDiscountAsk` is "the pure money-correctness core"; customer resolution is an exact `findByPhoneNormalized` match. A real customer + location + job + a $100.00 `POST /api/estimates` (line item stamped `pricingSource:'manual'` — a human-entered price, which is what makes `isEstimateCatalogGrounded` true and lets the floor be trusted; without it the estimate is ungrounded and the decision downgrades to `NEEDS_APPROVAL` instead of `REJECT_WITH_COUNTER`, confirmed directly) + `.../send`, then a signed inbound SMS asking "$50 off" — below the tenant's real $60.00 floor (`PUT /api/settings/`) — refuses: a `callback` proposal counters at the floor, never quotes the ask, and audits `negotiation_guardrail.sms_routed` twice per message (the U5b discount-evaluation audit carrying `decisionKind`, and the handler's own unconditional final audit carrying `askType`/`proposalId` — both keyed on the same inbound `MessageSid`). Idempotent on a Twilio-shaped retry (same `MessageSid`): still exactly one proposal. T1: tenant B's own, much looser floor ALLOWS the identical ask on an identical quote — never governed by tenant A's $60 floor, and the guardrail still routes a callback (every decision branch does), just with an approving recommendation instead of a counter.

## Row 2.12 — a property-manager caller reaches the B2B-context assembly path (T3; observable-difference leg pinned #1119-class)

**File:** `e2e/telephony-capture-2-12.spec.ts`

`loadB2bAccountContext` runs inside `handleInbound` for every resolved customer and is genuinely reachable (T3: property-manager customer, residential customer, and a no-B2B tenant B caller all succeed in one run). The row's own "observably different" claim cannot be shown on this hermetic surface: the mock's `classify_intent` branch reads only the last `role:'user'` message, and #1010's B2B context always rides a separate `role:'system'` message the mock never inspects — a property-manager caller and a residential caller speaking the identical turn produce an identical classification with no live model, and `ctx.priority` has no other consumer anywhere in the codebase to route on instead. Pinned with `test.fail()`. **Normalization note:** each call's TwiML embeds a fresh random session id in the `<Gather>` action URL — the pinned comparison strips `sid=<uuid>` before comparing, otherwise the assertion "passes" for the trivial reason that any two calls' raw TwiML always differ by that UUID alone (confirmed directly — the un-normalized comparison passed for the wrong reason on first write). **Product gap, report only:** no owner-facing route sets a customer's `accountType` at all (`createCustomerSchema`/`routes/customers.ts` never mention it) — this spec configures it by direct SQL, the only way to reach this state today.

---

## What is NOT proven (honest list)

- **2.2 / 2.6**: no `audit_events` row for the grant/triage-outcome write on this branch — lands via draft PR #1136 (not merged), out of scope for this test-only lane.
- **2.6 grading, 2.12 observable difference**: pinned `test.fail()` — genuinely need a live model (`AI_PROVIDER_API_KEY`) to reach; #1119-class.
- **2.8 drafting**: pinned `test.fail()` — a hermetic-mock bug (JSON key name leaking into the drafted description via `extractName`'s quoted-string fallback) blocks catalog grounding for every MMS draft under this hermetic boot, not just this spec's inputs. Reported above; not fixed (test-only lane); a real model or a `mock.ts` fix would close it.
- **2.5 Spanish clause**: unchanged, still parked on decision #1056.
- **2.12 `accountType` configurability**: no owner-facing route exists; flagged as a product gap for Fable to file.

## Commands and raw results

Environment (every invocation): real Postgres via `e2e/fixtures/setup-test-db.ts` against a `pgvector/pgvector:pg16` container (`DOCKER_HOST`/`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` via colima), dedicated api port 38580 (`PORT`/`E2E_API_URL`/`PUBLIC_API_URL`/`VITE_API_URL` all set to it), `TWILIO_*` fakes + `TENANT_ENCRYPTION_KEY` (64 hex) + `E2E_DEV_AUTH=0`, `TS_NODE_TRANSPILE_ONLY=true` (see environment note above), held under the shared test lock for the duration of each run.

```
npx playwright test telephony-capture-2-1.spec.ts telephony-capture-2-2.spec.ts \
  telephony-capture-2-3.spec.ts telephony-capture-2-4.spec.ts telephony-capture-2-6.spec.ts \
  telephony-capture-2-8.spec.ts telephony-capture-2-10.spec.ts telephony-capture-2-11.spec.ts \
  telephony-capture-2-12.spec.ts --project=chromium --retries=0 --workers=1
```
→ **24 passed** (27.1s) — includes the two pinned `test.fail()` tests (2.6, 2.12), which Playwright counts as passed expectations. Run twice green (individually per-file first, then this combined run); both green.

```
npx playwright test telephony-capture-2-7.spec.ts --project=chromium --retries=0 --workers=1 --timeout=200000
```
→ **2 passed** (1.9m first run, 1.6m second run) — run twice green separately (its own real ~100-120s wait dominates runtime, so it is kept out of the combined batch above to keep iteration fast; both runs' sweep logs show `due:2, sent:2, skipped:1` in the same tick).

```
npx playwright test telephony-e1-signed-webhook.spec.ts --project=chromium --retries=0 --workers=1
```
→ **6 passed** (row 2.5, pre-existing file, unchanged — confirms it still holds on this branch).

Total across this lane: **32 passed, 0 failed** (2 of which are intentional `test.fail()` pins), across 9 new spec files + 1 fixture file + 1 pre-existing file re-confirmed.
