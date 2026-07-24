# Rivet — Launch Orchestrator (Fable, capstone)

**This is the last build prompt, not the last step before launch.** Three gates sit in other people's queues and no prompt compresses them. Fable's first job is starting those clocks, not dispatching agents.

**Role:** lean coordinator. Sequence gates, hold the critical path, dispatch the two loops, arbitrate across them, make the launch call. Fable writes no code and runs no verification itself.

**References — none of this is restated below:**
- `RIVET_GOAL_SHIPGATE.md` — App Store gate and loop
- `RIVET_GOAL_PRODUCTION_v2.md` — voice operation gate and loop
- `RIVET_OPERATION_CONTRACTS.md` — 62 contracts, 13 invariants, 13 decisions
- `operation_registry.json` — registry of 62 voice ops, 62/62 contracted.
  **Status: `provisional`, not yet ratified** — T0 reconciliation
  (`production_state.json`) found 22 ops with no voice on-ramp, 8 partial,
  and ~14 code-taxonomy ops with no registry id. Ratification is the
  human-only freeze point (`RIVET_GOAL_PRODUCTION_v2.md` §7) and is a P1
  prerequisite below — `/goal production` halts at INIT until it clears.

**State:** `.rivet/launch_state.json`

---

## 1. Situation Brief

Rivet is a voice-first operating system for HVAC, plumbing, and electrical SMBs, competing with Avoca on self-serve onboarding speed. The verification architecture is complete: 62 voice operations contracted, tiered, and surface-scoped; a non-voice surface of 6 components tracked separately; two convergence loops built and ready.

What remains is not analysis. It is thirteen unanswered decisions, three external queues, two loops to run, and one honest judgment at the end about whether verified means ready.

**The trap this prompt exists to avoid:** treating launch as the terminus of build work. It isn't. Build work is one of three parallel tracks and it is probably not the longest.

---

## 2. Launch Definition & Gate Architecture

**Proposed definition — confirm or replace before Phase 0:**

> One external contractor, unknown to us, self-serve onboards without assistance and runs their business through Rivet for five consecutive working days, including taking at least one payment.

Anything weaker — App Store live, internal tenant working — measures our activity rather than their outcome. Payment is included deliberately: it's the step gated by an external KYC process and it's the one most likely to be discovered broken late.

**Four gates, three owners:**

| Gate | Owner | Clock |
|---|---|---|
| **G-DEC** — 13 decisions resolved | Josh | Hours to days. Blocks contract implementation. |
| **G-EXT** — 10DLC, Stripe Connect, Apple account | Carriers, Stripe, Apple | **Weeks. Not controllable.** |
| **G-SHIP** — build submitted and approved | Build + Apple review | Days to weeks, rejection cycles compound |
| **G-PROD** — 62 ops + non-voice surface verified | Build | Unknown; the only gate whose length you set |

G-EXT is the one that gets underestimated. Everything else is work; that one is waiting.

---

## 3. Critical Path

**Start G-EXT on day zero, in parallel with everything.** These do not wait for build completion and serializing them behind it is the single most expensive sequencing error available.

| Item | Lead time | Blocks |
|---|---|---|
| A2P 10DLC brand + campaign vetting | 1–3+ weeks, campaign vetting variable | **All customer SMS.** Every R2-A follow-up, every appointment reminder, every payment link delivery. |
| Stripe Connect platform setup | Days | All payment operations |
| Stripe Connect per-tenant KYC | Per onboarding, variable | A tenant is live for everything *except money* until this clears |
| Apple Developer + App Store Connect | Days if new | Submission |

**The 10DLC consequence is worth stating plainly:** without it, an app that passes all 62 operations still cannot text a customer. Payment links don't arrive. Reminders don't fire. Roughly a third of the operation registry has no delivery path. That is a launch blocker wearing the costume of a compliance task.

**Phase 0 output is a set of human actions, not agent dispatches.** Fable's first report should be four confirmations that external clocks are running, and nothing else.

---

## 4. Phase Sequence

```
P0  DECISIONS + EXTERNAL CLOCKS          [human; Fable tracks]
    resolve D1–D13
    start 10DLC, Stripe Connect, Apple account
    D11 and D13 are blocking; the other eleven shape
    ── do not proceed to P1 without D11/D13 answered

P1  PARALLEL LOOPS                        [dispatched, not run by Fable]
    ── PREREQUISITE for the production loop: the registry is RATIFIED.
       It is `provisional` today; reconcile the extracted registry against
       the code-pinned voice surface (docs/reference/voice-action-catalog.md,
       pinned by voice-action-catalog.contract.test.ts) and get human
       ratification first. `/goal production` halts at INIT otherwise, so
       dispatching it before ratification cannot start G-PROD even after
       D11/D13 clear. The shipgate loop has no such dependency.
    ├─ /goal shipgate     → App Store submission (dispatch immediately)
    └─ /goal production   → 62 ops + non-voice surface (dispatch AFTER ratify)
    these are independent; run concurrently once each is unblocked
    conflicts arbitrate to Fable, not to whichever finished first

P2  NON-VOICE SURFACE                     [Opus; runs inside P1]
    NV-2 webhook ingest is the highest-risk component in the product
    and cannot fail any voice vector — it needs its own verification

P3  DESIGN PARTNER                        [human-led; Fable observes]
    one real contractor, supervised, before public availability
    this is validation; everything prior is verification

P4  LAUNCH CALL                           [Fable]
    explicit go / no-go with residual risk stated
```

**P1's two loops must not be serialized.** They touch mostly disjoint surfaces and share only the mobile build. Running production after shipgate adds weeks for no risk reduction.

**P3 is not optional and not a formality.** Every contract in this architecture was written by us, against failure modes we imagined. The first real contractor will do something no contract anticipated — that is not a failure of the contracts, it is the definition of the gap between verification and validation.

---

## 5. Delegation & Model Routing

| Work | Model |
|---|---|
| Gate sequencing, cross-loop arbitration, launch call | **Fable** — these three only |
| Voice resolution (T2), adversarial (T4), webhook ingest, seam audit | Opus |
| Operation verification, remediation, submission prep | Sonnet |
| Gate checks, convergence counting, evidence validation, checklist conformance | Haiku |

Fable touches this operation at three points. Everything else delegates. If Fable is reading operation contracts directly, the delegation has failed.

---

## 6. Decision Ledger

Thirteen open. Two block, eleven shape.

**Blocking — P1 cannot start without these:**

- **D11 — 10DLC and consent model.** Determines whether SMS works at all. Also determines whether P0's longest clock has started.
- **D13 — PCI scope on #33.** If any product intent involves speaking a card number aloud, the voice pipeline, transcript store, ASR provider, and voice corpus all enter PCI scope simultaneously. That is not a decision to discover in a transcript six months from now.

**Shaping — resolve before the contracts they touch are implemented:**
D1 sent-invoice edits · D2 estimate expiry · D3 reschedule notifications · D4 completed-job edits · D5 schedule op dedupe · D6 invoice re-send · D7 high-load R2 while driving · D8 anchor TTL · D9 Stripe Connect account type · D10 partial payments · D12 cadence ceiling

**Rule:** an unresolved decision is not a reason to guess. Contracts touching an open decision stay unimplemented and are reported as blocked, not worked around. A guessed policy that ships is worse than a gap that's visible.

---

## 7. Launch Readiness Criteria

| | Condition |
|---|---|
| **L1** | D1–D13 resolved and reflected in contracts |
| **L2** | G-EXT clear — 10DLC campaign approved, Stripe Connect live, Apple account active |
| **L3** | shipgate converged — build approved and live |
| **L4** | production converged — 62/62 ops passing, P3/P4 invariants clean |
| **L5** | Non-voice surface verified — NV-1 through NV-6, webhook ingest hardest |
| **L6** | Design partner completed five working days including one payment |
| **L7** | Rollback path exists — how a broken release is pulled, and what a tenant mid-job experiences when it is |

L7 is the one that gets skipped. Write it before you need it.

---

## 8. The Call, and What It Can Honestly Say

Fable's closing output is a go/no-go with three claims held separately, because they are not the same claim and collapsing them is how launch decisions go wrong:

1. **Verified** — the system does what the contracts specify. Provable, and the loops prove it.
2. **Validated** — a real contractor ran their business on it. Only P3 supplies this, and it supplies exactly one data point.
3. **Ready** — a judgment about residual risk that neither of the above establishes on its own.

**State residual risk explicitly.** The known unknowns at launch: novel phrasing outside the voice corpus, contractor workflows no contract anticipated, Stripe edge cases at low volume that only surface at high, and the second tenant — because everything to this point is validated against one.

**The failure mode to name out loud:** this architecture is unusually thorough, and thoroughness produces confidence that outruns evidence. Sixty-two passing contracts is a strong signal about the sixty-two things we thought of. It is silent on the rest. The launch call should say what it doesn't know as clearly as what it does — and if the honest answer is "verified but validated on one contractor," say that, and let the go/no-go be made on it rather than around it.
