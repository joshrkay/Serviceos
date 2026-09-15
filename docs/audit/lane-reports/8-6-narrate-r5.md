# §8.6 Narrate — rung-5 reachability lane report (map #995, ticket #1019)

Lane: `test/8-6-narrate-r5`, Sonnet, **TEST-ONLY**. Base: `origin/main` at
`eb03570c3` (PR #1141 merged). No product code touched
(`packages/api/src`, `packages/web/src` unchanged) — everything below is a
finding about existing behavior, never a fix. No rung claimed anywhere in
this report, the PR title, or the ticket comment — that is Fable's call.

Rows in scope: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.9 (each already at Fable's
"4" — write + audit proven at real Postgres, ≥T1 — per
`docs/PRD-v5-as-built.md` §8.6). The job here was **reachability**: drive
each capability through the REAL surface (the owner's `/assistant` chat →
real `POST /api/assistant/chat` → proposals in the real inbox → approval →
real rows), with a second tenant (T2) in every run. Row 6.8 is rung 0
(parked, #1001) — report-only, below.

Two spec files:

- `e2e/journeys/narrate-owner-command-6-2-6-3-6-7.spec.ts` — the three rows
  that ARE reachable: 6.2, 6.3, 6.7.
- `e2e/journeys/narrate-owner-command-gaps-6-4-6-5-6-6-6-9.spec.ts` — the
  four rows that are NOT reachable from this surface today (6.4, 6.5, 6.6,
  6.9), each pinned with `test.fail()` naming the exact seam.

## How the "reachable vs. pinned" split was decided

The model is the hermetic mock (no `AI_PROVIDER_API_KEY`). Reachability
without a live model requires a DETERMINISTIC pre-LLM short-circuit in
`packages/api/src/ai/orchestration/intent-classifier.ts`. The complete
inventory of exported `match*Phrase` functions in that file (`grep '^export
function match'`) is: `matchExtendedIntentPhrase`, `matchEnRoutePhrase`,
`matchLookupEstimatesPhrase`, `matchDraftEstimatePhrase`,
`matchLookupBalancePhrase`, `matchLookupAccountSummaryPhrase`,
`matchLookupJobProfitPhrase`, `matchNewBookingPhrase`,
`matchIssueInvoicePhrase`, `matchUpdateJobPriorityPhrase`,
`matchAddCrewMemberPhrase`, `matchApplyLateFeePhrase` — plus
`OWNER_OPERATOR_COMMAND_PATTERNS` (`create_customer`, `update_customer`,
`lookup_customer`, `convert_lead`, `create_job`, `update_invoice`,
`draft_estimate` (quote), `send_invoice`). **None of these classify
`lookup_jobs`, `update_estimate`, `add_note`, `log_expense`, `log_mileage`,
or `add_material`** — confirmed by `EXTENDED_INTENT_PHRASES`'s own doc
comment (intent-classifier.ts:1467-1479), which explicitly rules out any
entity-bearing lookup from that table by design. On the real chat surface,
a message for one of those six intents reaches the real gateway call, and
the hermetic mock (`ai/providers/mock.ts`'s `scriptHermeticResponse`,
`classify_intent` branch, lines 160-197) only deterministically classifies
`create_customer` / `draft_estimate` / `create_invoice` from keyword
regexes — everything else genuinely returns `{ intentType: 'unknown',
confidence: 0.2 }`. That is rows 6.4, 6.5, 6.6 and 6.9's seam: pinned, not
faked.

**Two additional findings surfaced while building the reachable rows**,
both reported here rather than worked around:

1. **`create_customer`'s deterministic short-circuit is real but
   UNREACHABLE from the owner's actual Assistant UI.** A CLIENT-SIDE
   navigation shortcut in `packages/web/src/hooks/useVoiceCommands.ts:37`
   (`\b(new|create|add)\s+${FILLER}(customer|client)\b`, wired into
   `AssistantPage.tsx`'s own `send()` at line ~934 via `matchVoiceCommand`)
   intercepts ANY "new customer …" / "add a customer …" turn — typed OR
   voice — before it ever reaches `POST /api/assistant/chat`, and silently
   redirects to the blank `/customers/new` form instead. Empirically
   confirmed live: a real `page.waitForResponse` for `/api/assistant/chat`
   never resolved (90s timeout) and the server's own request log shows
   ZERO `POST /api/assistant/chat` requests for that turn. 6.2 was redrafted
   onto `issue_invoice` instead (see below), which has no such collision.
2. **`matchUpdateJobPriorityPhrase` ("Mark the X job as high priority")
   classifies the intent and resolves the JOB deterministically, but the
   PRIORITY VALUE requires a second, un-scripted gateway call.**
   `UpdateJobTaskHandler` (`ai/tasks/job-edit-task.ts:161-162`) calls
   `gateway.complete({ taskType: 'update_job', ... })` to parse
   status/priority/title/description out of the raw message — the hermetic
   mock has NO branch for `taskType === 'update_job'`, so it falls to the
   generic `{ok:true,mock:true,taskType,note:'hermetic-mock'}` stub with no
   `priority` field at all. Empirically confirmed: the drafted proposal
   failed `updateJobPayloadSchema` ("requires at least one field to
   change"). 6.3 was redrafted onto `matchLookupJobProfitPhrase` instead —
   same `EntityResolver`/`kind:'job'` mechanism, zero gateway calls (a
   read-only skill never touches the LLM).

Neither finding blocked a row (both had a working alternative reachable
mechanism), so neither needed `docs/audit/blocked-on-josh.md` — reported
here and in the PR/ticket instead.

---

## Infra used throughout

```bash
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
export TESTCONTAINERS_RYUK_DISABLED=true
npx tsx e2e/fixtures/setup-test-db.ts
# → export DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_e2e_test
```

then, per spec file, from the repo root, dedicated ports (per the lane
preamble — api 38590, web 38591):

```bash
PORT=38590 E2E_API_URL=http://localhost:38590 PUBLIC_API_URL=http://localhost:38590 \
  VITE_API_URL=http://localhost:38590 E2E_WEB_PORT=38591 \
  CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<that url> E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
  npx playwright test <spec> --project=chromium --retries=0 --workers=1 --reporter=list
```

`E2E_USE_TEST_DB=true`'s `global-teardown.ts` truncates every table at the
end of each `npx playwright test` process, so every spec below polls
Postgres directly (via the `queryAsTenant` helper) and `console.log`s the
result during the run — before teardown — via `logRows()`. Each file was
run **twice, green both times**, with a fresh testcontainer each run (no
shared state between runs). Screenshots saved under
`docs/audit/lane-reports/8-6-narrate-r5/`.

---

## File 1 — reachable rows: 6.2, 6.3, 6.7

`e2e/journeys/narrate-owner-command-6-2-6-3-6-7.spec.ts`

### Row 6.2 — a spoken command becomes a typed, validated proposal

**Mechanism:** `matchIssueInvoicePhrase` ("Issue invoice INV-####",
intent-classifier.ts:1917-1918) → `IssueInvoiceTaskHandler`
(`ai/orchestration/task-router.ts:142-236`, zero gateway calls — resolution
is entirely synchronous rung 1/2/3 reference matching) →
`IssueInvoiceExecutionHandler`.

**What it proves:** a real owner types "Issue invoice INV-0001." at
`/assistant`; the drafted `issue_invoice` proposal (`invoiceId: "INV-0001"`
at draft time — the raw reference string, resolved to a real UUID only at
execution) passes `issueInvoicePayloadSchema.safeParse`; Approve flips the
REAL invoice row `draft → open` and writes a real `invoice.issued` audit
row. A genuinely unclassifiable "mumble" mints NO proposal (before/after
count unchanged). A neighbour tenant gets a 404 reading the invoice and has
none of its own.

**Command (same recipe as above, spec file 1):**
```bash
npx playwright test e2e/journeys/narrate-owner-command-6-2-6-3-6-7.spec.ts --project=chromium --retries=0 --workers=1 --reporter=list
```

**GREEN (final run, all 3 specs in the file):**
```
  3 passed (1.6m)
```

**Row dumps (from the run):**
```
[8.7 row-dump] 6.2 issue_invoice proposal payload
{
  "id": "6cc6c5d1-0cf8-4eae-b0a3-9b65f48f050c",
  "payload": { "invoiceId": "INV-0001" },
  "status": "ready_for_review"
}
[8.7 row-dump] 6.2 invoice row after approve
{ "status": "open" }
[8.7 row-dump] 6.2 audit_events invoice.issued
[ { "event_type": "invoice.issued" } ]
[8.7 row-dump] 6.2 mumble — proposals count before/after
{ "before": 1, "after": 1 }
[8.7 row-dump] 6.2 T2 — tenant B cross-read of tenant A invoice
{ "status": 404 }
```

Screenshots: `6.2-drafted-issue-invoice.png`, `6.2-approved-issue-invoice.png`,
`6.2-mumble-no-proposal.png`.

### Row 6.3 — "the Henderson job" resolves through the real chat surface

**Mechanism:** `matchLookupJobProfitPhrase` ("Did I make money on the X
job?", intent-classifier.ts:1775-1785) → `dispatchAssistantLookup`
(`ai/orchestration/lookup-dispatch.ts`) → the SAME `EntityResolver`
(`kind: 'job'`) `test/integration/entity-resolution.test.ts`'s "Henderson
job" T2 proof already uses → the real, LLM-free `lookupJobProfit` skill.

**What it proves:** two independently bootstrapped tenants, EACH with a
genuinely matching "Henderson" job (mirroring the integration test's T2
shape — a neighbour with real data, not a data-free stranger) and
DIFFERENT real revenue ($300.00 / $700.00, via a real issued invoice per
tenant). Each owner, in their own real browser session, asks "Did I make
money on the Henderson job?" and hears ONLY their own tenant's figure —
never the other's.

**Row dump:**
```
[8.7 row-dump] 6.3 T2 — two tenants, both a genuine "Henderson" job, divergent real revenue, each hears only its own
{
  "tenantA": { "tenantId": "c7efdb8c-d4c3-4e66-92d7-aaea0ccdbc9c", "jobId": "8b426d5f-e414-4c09-a220-fe013baaec3d", "expected": "$300.00" },
  "tenantB": { "tenantId": "...", "jobId": "...", "expected": "$700.00" }
}
```

Screenshots: `6.3-tenantA-job-profit.png` (real reply: *"The Pat — §8.7
quote lane job job brought in $300.00; about $300.00 margin (100%). That's
not counting your labor rate — set one in settings to include it."*),
`6.3-tenantB-job-profit.png`.

### Row 6.7 — "ask for my numbers out loud"

**Mechanism:** `matchLookupBalancePhrase` ("What does X owe me?",
intent-classifier.ts:1727-1736) → `dispatchAssistantLookup` → the SAME
`executeLookupAnswer` (`workers/voice-lookup-answer.ts`)
`test/integration/voice-lookup-answer.test.ts` already proves at real
Postgres.

**What it proves:** two tenants share the SAME customer name ("Robin
Delgado") with DIFFERENT real outstanding balances ($45.00 / $999.00, via a
real issued invoice each). Two independent real browser sessions
(`browser.newContext()` each) each ask "What does Delgado owe me?" and each
hears ONLY its own tenant's real computed figure.

**Row dump:**
```
[8.7 row-dump] 6.7 T2 — two tenants, same customer name, divergent real balances, each hears only its own
{
  "tenantA": { "tenantId": "1582dcd4-d1f5-48a5-a5c4-b97b34808100", "expected": "$45.00" },
  "tenantB": { "tenantId": "38844864-e749-4344-b8cd-5d4d86a6800e", "expected": "$999.00" }
}
```

Screenshots: `6.7-tenantA-balance.png` (real reply: *"Your current balance
is $45.00, due October 13."*), `6.7-tenantB-balance.png`.

---

## File 2 — pinned seams: 6.4, 6.5, 6.6, 6.9

`e2e/journeys/narrate-owner-command-gaps-6-4-6-5-6-6-6-9.spec.ts`

Each test drives the REAL, unmodified `POST /api/assistant/chat` with the
row's own acceptance-criterion phrasing, asserts the GENUINE current
behavior at real Postgres (no proposal minted, for either tenant — T2:
the non-effect is at least tenant-isolated), then pins the missing
capability with `test.fail(true, '<seam, file:line>')` — the aspirational
assertion (the capability as the story describes it) is expected to fail,
and does.

**Command:**
```bash
npx playwright test e2e/journeys/narrate-owner-command-gaps-6-4-6-5-6-6-6-9.spec.ts --project=chromium --retries=0 --workers=1 --reporter=list
```

**Result (final run):** `4 passed (1.7m)` — all four `test.fail()`
pins failed for the expected reason (confirmed below), which Playwright
reports as a pass.

### 6.4 — "where does the Garcia job stand?" never reaches `lookup_jobs`

Real job status: `"new"`. Real chat reply (assistant-honesty-guard active —
server log: `"assistant/chat: suppressed fabricated action confirmation" ...
claim":"I drafted"`): *"I'm not sure what you wanted me to do there, so I
haven't done it — I haven't scheduled, logged, or changed anything. Tell me
which job or customer you mean and what you want, and I'll draft it for you
to approve."* Never mentions the real status. No proposal minted for
either tenant (genuine, T2). Screenshot: `6.4-no-real-answer.png`.

**Pin:** `intent-classifier.ts`'s own doc comment (:1467-1479) rules out
entity-bearing lookups from the phrase table by design; `mock.ts:160-197`
classifies this as `unknown`; `isLookupIntent()` (routes/assistant.ts:2596)
never fires; the wired `lookup_jobs` case
(`workers/voice-lookup-answer.ts:494`) is never reached.

### 6.5 — "add two hours of labor to the Garcia estimate" never reaches `update_estimate`

`estimate_line_items` count unchanged for BOTH tenants (before/after: 1/1).
Real chat reply: *"I can help with invoices, scheduling, follow-ups,
estimates, and creating customers. Tell me what you want to do next."*

**Pin:** no deterministic short-circuit for `update_estimate` anywhere in
`intent-classifier.ts`; `CHAT_INTENT_TO_REGISTRY_KEY.update_estimate`
(routes/assistant.ts:2150) is real and wired, but classify_intent never
confidently names it without a live model.

### 6.6 — "$40 in parts for the Henderson job" never reaches `log_expense`

No proposal minted for either tenant (genuine, T2); neither tenant's reply
carries the other's job id. Same honesty-guard reply as 6.4.

**Pin:** no deterministic short-circuit for `log_expense` (nor its
`log_mileage` alias); `CHAT_INTENT_TO_REGISTRY_KEY.log_expense`
(routes/assistant.ts:2170) is real and wired (`LogExpenseTaskHandler`),
unreachable from chat without a live model.

### 6.9-on-chat — "three-quarter copper, twenty feet for the Henderson job" never reaches `add_material` via chat

`material_items` count unchanged for either tenant. Same honesty-guard
reply.

**Pin:** no deterministic short-circuit for `add_material`;
`CHAT_INTENT_TO_REGISTRY_KEY.add_material` (routes/assistant.ts:2188) is
real and wired (`AddMaterialTaskHandler` + the real write, already proven
at real Postgres by `test/integration/material-items.test.ts`, #1019 6.9),
but only reachable via a scripted router classification today — never
end-to-end through `POST /api/assistant/chat`.

---

## Row 6.8 — report only (rung 0, #1001)

Unchanged this lane. No `place` entity kind exists anywhere in the
product; parked per Josh's #1001 decision. Nothing to reach.

---

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit   # clean, no output
git status --porcelain                                              # only the two new spec files + this report + screenshots
```

## Not proven / scope notes

1. **6.3's "nine entity kinds" breadth.** This lane proves ONE entity kind
   (`job`) reachable end-to-end through the real chat surface with T2; the
   other eight kinds' resolution is already proven at the integration level
   (`test/integration/entity-resolution.test.ts`, 94/94). Exhaustively
   re-proving all nine kinds through a real browser was out of scope for a
   single reachability pass.
2. **6.2's "vertical context" phrase.** The deterministic short-circuit
   this row uses bypasses the gateway (and therefore any vertical-context
   system-prompt injection) entirely by design — that phrase in the
   acceptance criterion is more naturally proven by 7.1's
   `matchDraftEstimatePhrase` → `EstimateTaskHandler` path (already at
   rung 5), which this lane deliberately did not duplicate.
3. **Rows 6.4, 6.5, 6.6, 6.9 genuinely stop at the seam described above** —
   not faked, not worked around. Fable/the map owner files whatever ticket
   follows.
4. **Money/pricing/RLS/auth/migrations/supervisor gate:** not touched, per
   scope. No test in this lane exposed a defect in any of those areas
   beyond the two findings called out above (both classification/task-level,
   neither money- or auth-adjacent).
