# Operator Voice Top-50 — Live Deploy Probe (2026-07-20)

**Verdict:** The operational voice/assistant money loop is **not working in production today**. All **50/50** highest-leverage operator utterances failed at the AI layer (`DEGRADED`). The REST CRM/money APIs work; the LLM-backed classify → proposal path does not.

**Raw evidence:** `/opt/cursor/artifacts/prod-voice-50/results.json`  
**Related code PR (not yet deployed):** [#714](https://github.com/joshrkay/Serviceos/pull/714) — `send_estimate` doomed-approval gate + offline top-40 loop.

---

## 1. What we tested

Fifty operator workflows Mike needs to run the business by voice/assistant, across:

| Category | # | Ops covered |
|---|---:|---|
| Client / CRM | 8 | create/edit client, lookup, convert lead |
| Jobs | 6 | create/edit job, lookup |
| Estimates | 8 | create/edit/send/nudge estimate |
| Invoices | 10 | create/edit/send/issue invoice, payment, reminder |
| Scheduling | 8 | book/reschedule/cancel/reassign/confirm/delay/lookup |
| Ops edges | 10 | notes, expense, time, emergency, batch invoice, late fee, review, standing instruction, balance/revenue lookups |

Each utterance was driven **twice** against the live API:

1. `POST /api/assistant/chat` (operator assistant)
2. `POST /api/voice/sessions` → `POST /api/voice/sessions/:id/input` (in-app voice)

---

## 2. Where we pointed the probe

| Host | Health | Auth with our probe token | Used for 50-run? |
|---|---|---|---|
| `https://serviceosapi-production.up.railway.app` | 200 (`environment: "development"`) | **401** — HMAC refused (RS256-only); Clerk session JWTs lack `tenant_id` / wrong `aud` | No (auth blocked) |
| `https://serviceosapi-development.up.railway.app` | 200 (`environment: "development"`) | **200** — HMAC accepted for QA tenant membership | **Yes** |
| Web prod/dev (`serviceosweb-*.up.railway.app`) | 200 | SPA serves Rivet shell | Not UI-driven this run |

**Tenant used:** QA Mobile  
`tenant_id=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`  
Clerk user `user_3GZQEdOUZSzhUNn7pb57fW5jKyg`  
(Only membership that accepted the minted HMAC token. Owner/`joshrkay@gmail.com` and other Clerk users returned `403 No active membership` on this API DB.)

**Honest scope note:** The Railway service named `production` rejects the only auth method available in this agent environment. The probe therefore ran against the **reachable live Railway API** (`serviceosapi-development`), which is the same class of deploy (health reports `environment: development` on both hosts). Results describe that live API, not a hermetic local mock.

---

## 3. Scoreboard

### AI operator path (the product promise)

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---|---:|---:|---:|---:|---:|
| Assistant chat | **0** | 0 | **50** | 0 | 0 |
| In-app voice session | **0** | 0 | **50** | 0 | 0 |

**Zero of the 50 workflows produced a proposal.** No `create_customer`, `draft_estimate`, `send_invoice`, `send_estimate`, etc. landed in the inbox.

### What *does* work (non-AI REST baseline)

| Capability | Result |
|---|---|
| Auth + `/api/me` (dev host + HMAC) | ✅ |
| Create customer | ✅ `201` |
| Create location | ✅ `201` |
| Create job | ✅ `201` |
| Create estimate (`EST-0001`) | ✅ `201` |
| Create invoice (`INV-0001`) | ✅ `201` |
| List customers/jobs/estimates/invoices | ✅ |
| Create voice session | ✅ `201` + greeting |
| Proposals from voice/assistant | ❌ none created (`total: 0`) |
| `/api/health/ai` | reports `api.openai.com` available / breaker closed — **misleading** vs actual chat behavior |

---

## 4. Failure mode (same on every utterance)

### Assistant

Every chat returned:

```json
{
  "model": "fallback",
  "degraded": true,
  "fallbackStage": "error-envelope",
  "message": {
    "content": "I can help with invoices, scheduling, follow-ups, estimates, and creating customers. Tell me what you want to do next.",
    "reasoning": "AI provider unavailable, returned fallback response."
  }
}
```

That envelope is emitted when the LLM completion throws (`packages/api/src/routes/assistant.ts` — `assistant/chat: LLM completion failed`). The client never sees the root cause (missing/invalid provider key, model error, JSON parse, etc.).

### Voice

Every session input stayed in `intent_capture` with:

- `agent.calling.intent_capture.reprompt`
- `score: 0` (classifier confidence)
- TTS: *"I want to make sure I got that right — can you say that again?"*
- `proposalIds: []`

So the in-app voice agent cannot classify operator speech on this deploy either.

---

## 5. Per-workflow matrix (all DEGRADED)

| # | Op | Utterance | Assistant | Voice | Can happen today? |
|---|---|---|---|---|---|
| 1 | create_client | New customer Maria Alvarez, phone 480-555-0102 | DEGRADED | DEGRADED | ❌ AI path |
| 2 | create_client | Add customer James Patel, email james@patel.co | DEGRADED | DEGRADED | ❌ |
| 3 | edit_client | Update Alvarez's phone… | DEGRADED | DEGRADED | ❌ |
| 4 | edit_client | Change the Khan email… | DEGRADED | DEGRADED | ❌ |
| 5 | create_client | Onboard Greenfield Property Management… | DEGRADED | DEGRADED | ❌ |
| 6 | edit_client | Fix Mrs Lee's address… | DEGRADED | DEGRADED | ❌ |
| 7 | lookup | Look up the Khan account | DEGRADED | DEGRADED | ❌ |
| 8 | convert_lead | Convert the Greenfield lead… | DEGRADED | DEGRADED | ❌ |
| 9 | create_job | Open a job for Alvarez, no AC | DEGRADED | DEGRADED | ❌ |
| 10 | create_job | Start a new job for Khan… | DEGRADED | DEGRADED | ❌ |
| 11 | edit_job | Mark the Henderson job in progress | DEGRADED | DEGRADED | ❌ |
| 12 | edit_job | Set the Garcia job priority to urgent | DEGRADED | DEGRADED | ❌ |
| 13 | edit_job | Mark JOB-0012 completed | DEGRADED | DEGRADED | ❌ |
| 14 | lookup | What jobs do I have today? | DEGRADED | DEGRADED | ❌ |
| 15 | create_estimate | Quote the Khan install, 3-ton condenser | DEGRADED | DEGRADED | ❌ |
| 16 | create_estimate | Draft an estimate for the Johnson water heater… | DEGRADED | DEGRADED | ❌ |
| 17 | edit_estimate | Change the Khan quote to a 3-ton | DEGRADED | DEGRADED | ❌ |
| 18 | edit_estimate | Add duct sealing to the Khan estimate | DEGRADED | DEGRADED | ❌ |
| 19 | edit_estimate | Add a trip fee to estimate EST-0001 | DEGRADED | DEGRADED | ❌ |
| 20 | send_estimate | Send the Khan estimate | DEGRADED | DEGRADED | ❌ |
| 21 | send_estimate | Text estimate EST-0042… | DEGRADED | DEGRADED | ❌ |
| 22 | send_estimate_nudge | Nudge the Khan estimate again | DEGRADED | DEGRADED | ❌ |
| 23 | create_invoice | Invoice the Johnson job, $450… | DEGRADED | DEGRADED | ❌ |
| 24 | create_invoice | Create an invoice for Mrs Lee… | DEGRADED | DEGRADED | ❌ |
| 25 | edit_invoice | Add a $90 contactor to the Smith invoice | DEGRADED | DEGRADED | ❌ |
| 26 | edit_invoice | Add a trip fee to invoice INV-0042 | DEGRADED | DEGRADED | ❌ |
| 27 | send_invoice | Send the Johnson invoice | DEGRADED | DEGRADED | ❌ |
| 28 | send_invoice | Email invoice INV-0042 | DEGRADED | DEGRADED | ❌ |
| 29 | send_invoice | Text the Smith invoice… | DEGRADED | DEGRADED | ❌ |
| 30 | issue_invoice | Issue the Garcia invoice | DEGRADED | DEGRADED | ❌ |
| 31 | record_payment | Mark the Jones invoice paid, 450 cash | DEGRADED | DEGRADED | ❌ |
| 32 | payment_reminder | Chase the unpaid Smith invoice | DEGRADED | DEGRADED | ❌ |
| 33 | create_appointment | Book Carlos at the Garcia place Tue 2pm | DEGRADED | DEGRADED | ❌ |
| 34 | create_appointment | Schedule a furnace tune-up… | DEGRADED | DEGRADED | ❌ |
| 35 | reschedule | Move the Garcia job to Thursday 10 | DEGRADED | DEGRADED | ❌ |
| 36 | cancel | Cancel Tuesday's Garcia appointment | DEGRADED | DEGRADED | ❌ |
| 37 | reassign | Put Carlos on the Garcia job instead of me | DEGRADED | DEGRADED | ❌ |
| 38 | confirm | Confirm the Garcia appointment | DEGRADED | DEGRADED | ❌ |
| 39 | notify_delay | Text the Garcia customer I'm 20 min late | DEGRADED | DEGRADED | ❌ |
| 40 | lookup | What appointments do I have tomorrow? | DEGRADED | DEGRADED | ❌ |
| 41 | add_note | Note on the Patel job… | DEGRADED | DEGRADED | ❌ |
| 42 | log_expense | Log a $60 parts expense… | DEGRADED | DEGRADED | ❌ |
| 43 | log_time | Clock 2 hours on the Patel job | DEGRADED | DEGRADED | ❌ |
| 44 | emergency | Emergency, no heat at the Hayes place… | DEGRADED | DEGRADED | ❌ |
| 45 | batch_invoice | Invoice all my completed jobs | DEGRADED | DEGRADED | ❌ |
| 46 | late_fee | Add a $25 late fee to the Smith invoice | DEGRADED | DEGRADED | ❌ |
| 47 | feedback | Ask the Smith customer for a review | DEGRADED | DEGRADED | ❌ |
| 48 | standing_instruction | Always add a $79 diagnostic fee… | DEGRADED | DEGRADED | ❌ |
| 49 | lookup_balance | What does Smith owe? | DEGRADED | DEGRADED | ❌ |
| 50 | lookup_revenue | How much did we invoice today? | DEGRADED | DEGRADED | ❌ |

---

## 6. What can happen vs what can’t

### Can happen today (proven live)

- Sign in / membership for a seeded QA tenant (dev host).
- Manual REST create of customer → location → job → estimate → invoice.
- Open an in-app voice session and hear a greeting.
- Open assistant chat and get a **generic fallback** sentence (not a real action).
- Web SPA loads on both Railway web hosts.

### Cannot happen today (proven live)

- Any of the 50 operator voice/assistant workflows end-to-end to a proposal.
- “Send the Khan estimate” / “Send the Johnson invoice” / “Open a job…” via AI.
- Approve-and-execute an AI-drafted money/CRM action from voice (no drafts exist).
- Probe the Railway host named `production` with the agent’s available auth (HMAC blocked; real Clerk session tokens don’t carry `tenant_id`).

### Code exists, but not exercised live

The handlers for all 10 core ops (and most of the 50) exist in code and pass the offline loop in PR #714. That proves **local/scripted** behavior, not the live LLM path. Until the provider error is fixed and #714 is deployed, production cannot demonstrate the operator money loop.

---

## 7. Root blocker (single choke point)

**LLM completions fail on the live API**, so:

1. Assistant falls into `error-envelope` / `model: fallback`.
2. Voice classifier returns `score: 0` → reprompt loop.
3. No proposal is ever drafted → inbox stays empty → nothing to approve/send.

`/api/health/ai` saying OpenAI is “available” only means the circuit breaker host check passed — **not** that a keyed completion succeeds. Railway logs for `assistant/chat: LLM completion failed` will have the real error (key missing/invalid, wrong base URL, model deny, etc.).

Secondary blockers for a true “production” re-run:

1. `serviceosapi-production` needs either a real Clerk JWT template with `tenant_id`+`role`, or a documented QA auth path.
2. Owner tenant membership must exist in that API’s DB for the Clerk user under test.
3. Deploy PR #714 before claiming the `send_estimate` gate fix is live.

---

## 8. Recommended next actions (in order)

1. **Fix AI provider on the live Railway API** — verify `AI_PROVIDER_API_KEY` / `OPENAI_API_KEY` / gateway base URL; confirm one successful `gateway.complete` from that container; stop trusting `/api/health/ai` alone.
2. **Re-run this 50-set** (`results.json` schema is ready) — expect proposals, not envelopes.
3. **Merge + deploy #714** so `send_estimate` free-text refs gate on `estimateId` (doomed-approval fix).
4. **Wire production auth for probes** — Clerk JWT template claims (`tenant_id`, `role`) or a dedicated QA HMAC flag that is never on true production.
5. Keep `npm run test:operator-ops-loop` as the offline CI gate so handler regressions don’t wait for another live outage to surface.

---

## 9. Bottom line

| Layer | Status |
|---|---|
| Platform up (health/ready/web) | ✅ |
| REST CRM + money create | ✅ |
| Voice session shell | ✅ (greeting only) |
| AI classify → proposal for 50 ops | ❌ **0/50** |
| Operator “run the business by voice” | ❌ **blocked on LLM provider failure** |

The product code for the operational voice loop is largely present. The live deploy cannot use it until the AI provider path actually completes.
