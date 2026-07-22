# Operator Voice Top-50 — per-case failure tags

**Probe source:** `/opt/cursor/artifacts/operator-voice-50-post-merge-20260722-152627/results.json`  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Scoreboard:** Assistant **30/50** PASS · Voice **28/50** PASS  
**Corpus:** same 50 utterances as `operator-voice-50-live-2026-07-20.results.json`

---

## Tag key

| Tag | Meaning |
|-----|---------|
| **seed** | Needs QA fixture on Dev (Khan, Johnson, Mrs Lee, Smith, Garcia, Carlos, Greenfield lead, INV/EST docs, Tuesday appointment) |
| **seed-gap** | References entities **deliberately not seeded** (Alvarez, Patel, Jones, Henderson, Hayes) — may pass only after a prior create-customer run |
| **deploy** | First-turn **`escalating`** on unresolved entity — U5 routes to `intent_confirm` + `pendingReference` instead of on-call (requires U5 on Dev) |
| **classifier** | Reprompt at **`intent_capture`** (low confidence / parse) |
| **scorer** | Probe marks **PARTIAL** because no proposal was created — often acceptable for read-only / chat lookup intents |
| **ok** | Both surfaces PASS on this run |

---

## Full case matrix

| ID | Op | Utterance | Voice | Asst | First turn | Tags |
|----|-----|-----------|-------|------|------------|------|
| 1 | create_client | New customer Maria Alvarez, phone 480-555-0102 | PASS | PASS | intent_confirm | ok |
| 2 | create_client | Add customer James Patel, email james@patel.co | PASS | PASS | intent_confirm | ok |
| 3 | edit_client | Update Alvarez's phone number to 480-555-0199 | PARTIAL | PARTIAL | escalating | seed-gap, deploy |
| 4 | edit_client | Change the Khan email to office@khan.com | PARTIAL | PARTIAL | escalating | seed, deploy |
| 5 | create_client | Onboard Greenfield Property Management as a new customer | PASS | PASS | intent_confirm | ok |
| 6 | edit_client | Fix Mrs Lee's address to 88 Palm Court | PARTIAL | PARTIAL | escalating | seed, deploy |
| 7 | lookup | Look up the Khan account | PARTIAL | PARTIAL | escalating | seed, deploy, scorer |
| 8 | convert_lead | Convert the Greenfield lead to a customer | PASS | PARTIAL | intent_confirm | seed, scorer |
| 9 | create_job | Open a job for Alvarez, no AC | PARTIAL | PASS | escalating | seed-gap, deploy |
| 10 | create_job | Start a new job for Khan — kitchen drain replacement | PARTIAL | PASS | escalating | seed, deploy |
| 11 | edit_job | Mark the Henderson job in progress | PASS | PASS | intent_confirm | ok |
| 12 | edit_job | Set the Garcia job priority to urgent | PASS | PASS | intent_confirm | ok |
| 13 | edit_job | Mark JOB-0012 completed | PASS | PASS | intent_confirm | ok |
| 14 | lookup | What jobs do I have today? | PASS | PARTIAL | intent_confirm | scorer |
| 15 | create_estimate | Quote the Khan install, 3-ton condenser | PARTIAL | PASS | escalating | seed, deploy |
| 16 | create_estimate | Draft an estimate for the Johnson water heater replacement | PARTIAL | PASS | escalating | seed, deploy |
| 17 | edit_estimate | Change the Khan quote to a 3-ton | PARTIAL | PARTIAL | escalating | seed, deploy |
| 18 | edit_estimate | Add duct sealing to the Khan estimate | PARTIAL | PASS | escalating | seed, deploy |
| 19 | edit_estimate | Add a trip fee to estimate EST-0001 | PASS | PASS | intent_confirm | ok |
| 20 | send_estimate | Send the Khan estimate | PASS | PARTIAL | intent_confirm | seed, scorer |
| 21 | send_estimate | Text estimate EST-0042 to the customer | PASS | PARTIAL | intent_confirm | seed, scorer |
| 22 | send_estimate_nudge | Nudge the Khan estimate again | PASS | PASS | intent_confirm | ok |
| 23 | create_invoice | Invoice the Johnson job, 450 dollars capacitor plus labor | PARTIAL | PASS | escalating | seed, deploy |
| 24 | create_invoice | Create an invoice for Mrs Lee for 450 dollars cash | PARTIAL | PASS | escalating | seed, deploy |
| 25 | edit_invoice | Add a ninety dollar contactor to the Smith invoice | PARTIAL | PASS | escalating | seed, deploy |
| 26 | edit_invoice | Add a trip fee to invoice INV-0042 | DEGRADED | PASS | intent_capture | seed, classifier |
| 27 | send_invoice | Send the Johnson invoice | PARTIAL | PASS | escalating | seed, deploy |
| 28 | send_invoice | Email invoice INV-0042 | PASS | PASS | intent_confirm | ok |
| 29 | send_invoice | Text the Smith invoice to the customer | PASS | PASS | intent_confirm | ok |
| 30 | issue_invoice | Issue the Garcia invoice | PASS | PASS | intent_confirm | ok |
| 31 | record_payment | Mark the Jones invoice paid, 450 cash | PASS | PASS | intent_confirm | ok |
| 32 | payment_reminder | Chase the unpaid Smith invoice | PASS | PASS | intent_confirm | ok |
| 33 | create_appointment | Book Carlos at the Garcia place Tuesday at 2pm | PASS | PARTIAL | intent_confirm | seed, scorer |
| 34 | create_appointment | Schedule a furnace tune-up at the Smith house Tuesday at 2pm | PARTIAL | PARTIAL | escalating | seed, deploy, scorer |
| 35 | reschedule | Move the Garcia job to Thursday 10 | PARTIAL | PASS | escalating | seed, deploy |
| 36 | cancel | Cancel Tuesday's Garcia appointment | PARTIAL | PASS | escalating | seed, deploy |
| 37 | reassign | Put Carlos on the Garcia job instead of me | PARTIAL | PASS | escalating | seed, deploy |
| 38 | confirm | Confirm the Garcia appointment | PARTIAL | PASS | escalating | seed, deploy |
| 39 | notify_delay | Text the Garcia customer I'm 20 min late | PASS | PASS | intent_confirm | ok |
| 40 | lookup | What appointments do I have tomorrow? | PASS | PARTIAL | intent_confirm | scorer |
| 41 | add_note | Note on the Patel job: wants morning visits | PASS | PARTIAL | intent_confirm | seed-gap, scorer |
| 42 | log_expense | Log a 60 dollar parts expense on the Patel job | PASS | PARTIAL | intent_confirm | seed-gap, scorer |
| 43 | log_time | Clock 2 hours on the Patel job | PASS | PARTIAL | intent_confirm | seed-gap, scorer |
| 44 | emergency | Emergency, no heat at the Hayes place — page me | PASS | PARTIAL | escalating | seed-gap, scorer |
| 45 | batch_invoice | Invoice all my completed jobs | PASS | PASS | intent_confirm | ok |
| 46 | late_fee | Add a 25 dollar late fee to the Smith invoice | PASS | PASS | intent_confirm | ok |
| 47 | feedback | Ask the Smith customer for a review | PARTIAL | PARTIAL | escalating | seed, deploy |
| 48 | standing_instruction | From now on always add a 79 dollar diagnostic fee to AC calls | PASS | PARTIAL | intent_confirm | scorer |
| 49 | lookup_balance | What does Smith owe? | PARTIAL | PARTIAL | escalating | seed, deploy, scorer |
| 50 | lookup_revenue | How much did we invoice today? | PASS | PARTIAL | intent_confirm | scorer |

---

## Voice non-PASS rollup (22 cases)

| Tag | Cases touching voice failure |
|-----|------------------------------|
| **deploy** | 3, 4, 6, 7, 9, 10, 15, 16, 17, 18, 23, 24, 25, 27, 34, 35, 36, 37, 38, 47, 49 (21) |
| **seed** | 4, 6, 7, 10, 15, 16, 17, 18, 23, 24, 25, 27, 34, 35, 36, 37, 38, 47, 49 (20) |
| **seed-gap** | 3, 9 (2) |
| **classifier** | 26 (1) |
| **scorer** | 7, 49 (2; lookups that escalated) |

---

## Assistant-only PARTIAL (20 cases)

Most are **scorer** — chat answered without a proposal card while voice already PASS:

8, 14, 20, 21, 33, 40, 41, 42, 43, 44, 48, 50

Plus real chat gaps overlapping seed/deploy: 3, 4, 6, 7, 17, 34, 47, 49.

---

## Fix priority

1. **Seed fixtures twice** on Dev DB (`docs/runbooks/operator-voice-fixture-seed.md`) — unblocks ~20 entity references.
2. **Deploy U5** to Dev — stops on-call escalation for normal unknown refs on mutations (~21 voice cases).
3. **Classifier tuning** — #26 only (INV-0042 trip fee reprompt; browser demo succeeded same utterance).
4. **Probe scorer** — extend read-only accepted results for lookup intents (Task 1 Step 3 in implementation plan).

---

## Browser cross-check (2026-07-22)

| Case | Probe | Manual browser |
|------|-------|----------------|
| #26 INV-0042 trip fee | DEGRADED (classifier) | ✅ update_invoice proposal in inbox |
| #21 EST-0042 send | voice PASS | ✅ send_estimate proposal in inbox |
| #7 Khan lookup | escalating | ✅ escalating (Khan not in DB without seed) |

---

## Re-run after fixes

```bash
export DATABASE_URL='postgresql://…'
export CLERK_SECRET_KEY='sk_…'
/workspace/scripts/post-merge-operator-voice-50.sh
```

Expected lift after seed + U5 deploy: voice PASS should move sharply above 28/50 on entity-heavy cases (#4, 6, 7, 10, 15–18, 23–27, 34–38, 47, 49).
