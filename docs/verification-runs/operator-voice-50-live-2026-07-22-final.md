# Operator Voice Top-50 — Final Acceptance Run (2026-07-22)

**Branch:** `cursor/operator-voice-top-50-f809` (PR #720)  
**When:** 2026-07-22T14:26:36Z → 2026-07-22T14:30:02Z (API probe)  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Web:** `https://serviceosweb-development.up.railway.app`  
**Raw JSON:** `docs/verification-runs/operator-voice-50-live-2026-07-22-final.results.json`

---

## Verdict

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | **31** | 18 | 1 | 0 | 0 |
| In-app voice | **27** | 21 | 2 | 0 | 0 |

**Assistant:** 31/50 PASS (62%)  
**Voice:** 27/50 PASS (54%)

The plan target (≥40/50 PASS on both surfaces) is **not yet met** on the currently deployed Development API. This run is a truthful baseline after U1–U4 landed and before U5 (`not_found` → proceed instead of escalate) is deployed. Voice failures dominated by first-turn `escalating` on entity resolution (19 cases) should improve once U5 ships.

---

## Preflight

| Check | Result |
|-------|--------|
| Dev `/health` | 200 OK |
| Dev `/api/health/ai/completion` (×3) | 3/3 `ok: true`, model `gpt-4o-mini-2024-07-18` |
| HMAC auth `/api/me` | 200 — tenant `b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`, role `owner` |
| QA fixture seed (×2) | **Skipped** — `DATABASE_URL` not available in cloud agent; Development DB assumed pre-seeded from prior QA work |
| Secrets in artifacts | None recorded (HMAC minted at runtime only) |

---

## Probe method

Same 50 utterances as `operator-voice-50-live-2026-07-20.results.json`, executed by `scripts/probe-operator-voice-50-live.mjs`:

1. POST `/api/assistant/chat` with each utterance
2. POST `/api/voice/sessions` → first input turn
3. When first turn state is `intent_confirm`, send confirmation `"yes"`
4. Score with U1 truthful scorer (`scoreAssistant`, `scoreVoice`)

QA tenant: `b8e2dc0f-04c2-4ba0-9385-0ebcf3168052` (QA Mobile), Clerk user `user_3GZQEdOUZSzhUNn7pb57fW5jKyg`.

---

## Voice confirmation behavior (PASS cases)

All 27 voice PASS cases followed the expected two-turn mutation path where applicable:

- First turn reached `intent_confirm` (or emergency/on-call path for #44)
- Confirmation `"yes"` sent when `intent_confirm` was returned
- Final turn produced `proposalIds` or emergency/on-call evidence

Example (#1 create_client):

- `voiceFirstTurn.state`: `intent_confirm`
- `confirmationSent`: `true`
- `voice.state`: `closing`
- `proposalIds`: present

Emergency (#44):

- `voice.verdict`: PASS (`voice_emergency_oncall`)
- `notify_oncall` side effect + `emergency_dispatch` audit
- No proposal (by design)

---

## Voice non-PASS breakdown (23 cases)

| Failure class | Count | Workflow IDs | Notes |
|---------------|------:|--------------|-------|
| First-turn `escalating` (entity resolution) | 19 | 3,4,6,7,9,10,15–18,23–25,27,29,35–38,47,49 | Deployed API still escalates unknown refs; U5 changes this to `intent_confirm` + `pendingReference` |
| Classifier reprompt | 2 | 34, 39 | `voice_reprompt_low_confidence` at `intent_capture` |

---

## Assistant non-PASS breakdown (19 cases)

| Failure class | Count | Notes |
|---------------|------:|-------|
| Read-only / lookup (no proposal expected) | 12 | #7,14,20,21,40,41,42,43,47,48,49,50 — scorer marks PARTIAL (`no_proposal_non_degraded`); chat answered without a proposal card |
| Edit-client clarifications | 3 | #3,4,6 |
| Convert lead | 1 | #8 |
| Create/reschedule appointment | 2 | #33 PARTIAL, #34 DEGRADED (`llm_fallback_envelope`) |
| Emergency | 1 | #44 — chat gave general guidance; voice path correctly dispatched on-call |

---

## API persistence & tenant isolation

Executed after the probe against the same Development host:

| Check | Result |
|-------|--------|
| `GET /api/proposals` (tenant A token) | 200 — proposals returned with `tenantId=b8e2dc0f-…` |
| `GET /api/proposals/:id` read-back | 200 — proposal type/status match list |
| `GET /api/proposals/:id` (wrong tenant token) | **403** `No active membership for this tenant` |
| Cross-tenant audit list (wrong tenant) | **403** `FORBIDDEN` |

---

## Authenticated browser evidence

Recorded on Development web (already-authenticated owner session):

**Flow:** Assistant → Live session → voice text command → confirm → Inbox proposal → Approve → Customers list → Interactions audit

| Step | Evidence |
|------|----------|
| Voice command | "Create a customer named Maria Alvarez with phone 555-0101" |
| Confirmation | "yes" → agent queued `create_customer` proposal |
| Inbox | Proposal visible, awaiting approval |
| Approval | Executed successfully |
| Saved entity | Maria Alvarez, phone 555-0101 in Customers |
| Audit | Interactions shows completed voice call |

**Recording:** `/opt/cursor/artifacts/operator-voice-approval-demo.mp4` (3.1 MB)

No credentials or tokens appear in the recording.

---

## Comparison to prior runs

| Run | Assistant PASS | Voice PASS |
|-----|---------------:|-----------:|
| 2026-07-20 morning (pre AI fix) | 0 | 0 |
| 2026-07-20 post-merge | 10 | 0 |
| **2026-07-22 final (this run)** | **31** | **27** |

---

## Remaining gaps before 50/50

1. **Deploy U5** — stop first-turn on-call escalation for normal unknown entity refs; route to `intent_confirm` + proposal `pendingReference` instead.
2. **Fixture seed on Development** — run `seed-operator-voice-fixtures.ts` twice against Dev DB so Khan, INV-0042, EST-0042, Garcia Tuesday, Carlos resolve reliably (#3–7, 15–20, 35–38).
3. **Classifier reprompt tuning** — #34 create_appointment, #39 notify_delay still reprompt at `intent_capture`.
4. **Assistant read-only scoring** — lookup intents (#7,14,40,49,50) need accepted read-only result in probe scorer (Task 1 Step 3 note).

---

## Quality gate (local branch)

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Exit 0 on branch `cursor/operator-voice-top-50-f809` at commit including U5.

Docker-gated integration tests (`operator-voice-fixtures`, `entity-resolution`) require `DATABASE_URL` + testcontainers — not executed in this cloud agent run.

---

## Re-run commands

```bash
# Full 50-case probe
export CLERK_SECRET_KEY='…'
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-rerun \
  API_URL=https://serviceosapi-development.up.railway.app \
  node scripts/probe-operator-voice-50-live.mjs

# Fixture seed (from packages/api, requires Dev DATABASE_URL)
QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052 \
QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64 \
NODE_ENV=development \
DATABASE_URL='…' \
npx tsx scripts/seed-operator-voice-fixtures.ts
```
