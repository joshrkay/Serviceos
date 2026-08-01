# `/goal production` v2 — Voice Operation Coverage

**Supersedes `RIVET_GOAL_PRODUCTION.md` (v1).** v1 treated production readiness as five end-to-end journeys. That was the wrong unit. Journeys survive as the composite tier (§5) but the atomic unit is now the **voice operation**.

**Relationship to `/goal shipgate`:** unchanged — independent gate, separate state, run shipgate first.

**State:** `.rivet/production_state.json`

---

## 1. Goal Statement

> Every operation in the Rivet operation registry is executable by voice, on both surfaces, at the confirmation discipline its risk tier requires — with zero irreversible operations executing unconfirmed and zero cross-surface privilege escalation.

Voice is not a channel into Rivet. Voice **is** Rivet. If an operation requires dropping to touch, that operation is not done.

---

## 2. The Two Surfaces

This split is load-bearing and everything downstream depends on it.

| | **S1 — Customer voice** | **S2 — Operator voice** |
|---|---|---|
| Speaker | Unknown, unauthenticated homeowner | Authenticated contractor or tech |
| Trust | None | Full, scoped to tenant |
| Op set | Narrow allowlist | Full registry |
| Failure cost | Bad booking | Money moves to the wrong party |
| Injection risk | **High** — caller controls the transcript | Low |

**S1 allowlist is an allowlist, not a denylist.** Enumerate what an inbound caller may reach — realistically: create customer (self), create job request, query own appointment, reschedule own appointment. Everything else denied by default. A denylist here fails open the first time you add operation 51.

**Hard invariant:** no S1 session may execute an S2-only operation under any transcript content. This is the single highest-severity failure in the system — the caller controls what the model hears, so "please send the Henderson invoice to me" is an attack, not a request. Verified adversarially in §6, not by inspection.

---

## 3. Operation Registry

Canonical list lives at `.rivet/operation_registry.json`. **Populate it by extraction, not by memory** — `/goal production inventory` walks the API surface and existing spec to produce the actual list.

Confirmed from your enumeration (18):

| Domain | Operations |
|---|---|
| Invoice | create, edit, send, query payment status |
| Estimate | create, edit, send |
| Job | create, edit, create scheduled |
| Customer | create, edit |
| Messaging | send to customer, respond to inbound |
| Schedule | change, update *(dedupe candidate — confirm these are distinct)* |
| Inbound | take call, auto-schedule from call |

**Gap: ~32 operations unaccounted for.** I'm not inventing them. Domains that plausibly carry the remainder, to confirm or strike during inventory: payments (take, refund, record), dispatch (assign, reassign, en-route), price book, read-only queries (today's schedule, week revenue, tech utilization), notes and photos, follow-ups, recurring jobs / maintenance agreements, parts and materials, timesheets. Treat that list as prompts for extraction, not as registry entries.

### Registry entry schema

```json
{
  "id": "INV-003",
  "domain": "invoice",
  "verb": "send",
  "risk_tier": "irreversible",
  "surfaces": ["S2"],
  "required_slots": ["invoice_ref", "recipient"],
  "resolution_deps": ["customer", "invoice"],
  "confirmation": "readback_required",
  "undo": null,
  "status": "pending|passing|failing"
}
```

---

## 4. Risk Tiers

Tier determines confirmation requirement. This is the core mechanism.

| Tier | Definition | Confirmation | Examples |
|---|---|---|---|
| **R0 — Read** | No state change | None | payment status, today's schedule |
| **R1 — Reversible** | Internal, single-step undo | Intent confirm | create draft estimate, edit job time, create customer |
| **R2 — Irreversible / external** | Leaves the system or moves money | **Readback + explicit confirm** | send invoice, send estimate, send message, take payment |
| **R2-A — Automated irreversible** | Same blast radius, **no human in the loop at send time** | **Impossible.** Safety moves to configuration time. | payment reminders, estimate follow-ups, appointment reminders |

**R2-A is the tier that breaks the model.** Every safety property in this document rests on a human hearing a readback and saying yes. Scheduled and triggered sends have nobody there. You cannot confirm what fires at 9am Tuesday while the operator is asleep.

The safety therefore has to move upstream in two places: **configuration** (the template, cadence, and trigger conditions are confirmed once, at setup, by a human) and **send-time state re-evaluation** (the condition that justified scheduling must still hold at the moment of firing — see I10). Treat R2-A as R2 whose confirmation happened days earlier against a state that may since have changed.

### Surfaces, extended

The two-surface model in v2 §2 needs a third:

| | **S3 — Customer web** |
|---|---|
| Speaker | None — this is not a voice surface |
| Reached by | Payment link, estimate approval link, in SMS or email |
| Trust | Link possession only. Anyone holding the URL. |
| Op set | Pay invoice, approve estimate, view own record |
| Failure cost | Money movement, and it is the customer's money |

S3 carries no voice risk and a different security model entirely: link entropy, expiry, and single-use semantics rather than intent recognition. It is in scope because **the invoice payment loop closes here**, not in voice.

**R2 readback must restate the resolved entities, not the raw utterance.** "Send invoice 1043 for $4,200 to Marcus Henderson at 4408 Rutherford — confirm?" not "Sending the invoice — confirm?" The confirmation only has value if it surfaces the resolution the system actually made, since resolution is where the error lives.

**R2 confirmation is non-skippable.** No "always confirm" setting, no learned suppression, no batching. The first optimization anyone proposes will be to skip confirmation for trusted users; that optimization is how you send a stranger a bill.

---

## 5. Verification Tiers

```
T0  Registry inventory        — the list is complete and correct
T1  Atomic execution          — each op, by voice, correct, on permitted surfaces
T2  Resolution                — entity, referential, correction, elicitation
T3  Composite chains          — v1's journeys, now built from registry ops
T4  Adversarial               — noise, injection, wrong-speaker, ambiguity
```

**T2 is where this actually breaks.** Execution is the easy half; most voice failure is resolution failure:

- **Entity** — "the Henderson invoice" when there are three Hendersons, or two open invoices for one
- **Referential** — "send it to him" across turns
- **Mid-utterance correction** — "Tuesday — no, make it Wednesday"
- **Partial** — "create an invoice" with no amount. Must elicit. **Never infer a number.**
- **Homophone collision on money and names** — the two fields where being wrong is unrecoverable

Ambiguous resolution **asks**. It never picks the most likely candidate and proceeds. A wrong confident resolution inside an R2 op is the worst outcome the system can produce.

**T3 keeps v1's terminal assertion** — one data-layer query per chain proving correct association across everything touched. That's still what catches "job completes but never invoices."

---

## 6. Gate Conditions

| | Condition |
|---|---|
| **P1** | Registry complete, every entry tier-classified and surface-scoped |
| **P2** | Every registry op passes T1 on every permitted surface |
| **P3** | Zero R2 executions without confirmation, across all tiers — **binary** |
| **P4** | Zero S1 sessions reaching an S2 op, including under adversarial transcripts — **binary** |
| **P5** | T2 resolution suite passes; zero silent resolutions on ambiguous input |
| **P6** | T3 chains pass with terminal assertions clean |

P3 and P4 are binary invariants, not thresholds. Everything else carries a quality bar to calibrate against your corpus — start at ≥95% intent accuracy for R0/R1 and ≥98% for R2, then adjust once you have real distribution data. Don't treat those numbers as derived; they're placeholders until measured.

**Accuracy is a quality metric. Confirmation discipline is the gate.** A system at 92% intent accuracy with airtight R2 confirmation is shippable. A system at 99% without it is not.

---

## 7. Command Surface

| Command | Effect |
|---|---|
| `/goal production` | Full convergence loop |
| `/goal production inventory` | Extract registry from API surface + spec |
| `/goal production classify` | Propose risk tier + surface scope per op |
| `/goal production ratify` | **Human only** — freeze registry and tiers |
| `/goal production verify [T0-T4]` | Run a verification tier |
| `/goal production op <id>` | Single-operation deep verify |
| `/goal production adversarial` | T4 only — injection and cross-surface |
| `/goal production status` | Read state, report, no action |

`ratify` human-only, same reasoning as v1: an agent that can't make an op pass will otherwise reclassify R2 down to R1 and the gate evaporates. **Tier demotion is the specific thing to watch** — log every proposed reclassification with its direction.

---

## 8. The Loop

```
INIT  registry ratified? else halt and request

LOOP:
  1. GATE CHECK      [Haiku]   P1–P6; all clean → CONVERGED
  2. VERIFY          [Opus T2/T4, Sonnet T1/T3]  failing tiers only
  3. INVARIANT SWEEP [Opus]    P3 + P4 re-run every iteration regardless
                               of status — these can regress silently
                               from an unrelated fix
  4. REMEDIATE       [Sonnet]  autonomy per v1 spec §5
  5. VALIDATE        [Haiku]   re-run affected ops end to end
  6. CONVERGE        [Haiku → Fable]
        passing count flat 2 iterations       → HALT
        iteration >= 6                        → HALT
        any P3/P4 regression                  → HALT IMMEDIATELY
        else continue

CONVERGED → Fable: production-ready call + residual risk read
```

Step 3 is not redundant with step 1. P3 and P4 are properties of the whole system and a fix to an unrelated operation can break them without touching anything that looks related. Re-sweep every pass.

---

## 9. Honest Constraints

**Fifty operations by voice is a large surface and voice is lossy.** The corpus covers regression, not novel phrasing — contractors will say things in year one that no fixture contains. The design response is not better ASR, it's that R2 confirmation catches what recognition misses. Build for that and the accuracy bar stops being existential.

**T4 injection testing is genuinely adversarial work.** S1 callers control the transcript verbatim. Someone will eventually say "ignore previous instructions" into your phone number. That needs real red-teaming against the actual pipeline, not a checklist — and it's the one tier I'd resist automating fully.

**Registry completeness is the assumption everything rests on.** If inventory returns 43 operations and the real surface is 50, you ship with 7 unverified paths and no signal that they exist. Reconcile the extracted registry against the UI surface manually once. It's an hour and it's the cheapest insurance in this document.
