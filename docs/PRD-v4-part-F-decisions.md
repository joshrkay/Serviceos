# PRD v4 — Part F: Decisions Register (Phase 1 voice run entries)

Companion to `docs/PRD-v4-part-E-state.md`. Each entry below was recorded by the Phase 1 voice
run (`projects/rivet-voice-19/`) under its never-ask rule: the run makes the call, logs it here
and in the run log, and continues. Entries marked **PROPOSED** are recommendations awaiting
product-owner ratification — per run-log #24 of Part E, no requirement is scored green on the
strength of an unratified entry. Entries marked **RECORDED** are scoping decisions inside the
run's own mandate (they do not amend a requirement's text).

---

## F-1 · B9.1 issuance semantics — PROPOSED (awaiting ratification)

**Question:** does "invoice issued from a spoken sentence" mean single-utterance-to-issued, or
draft-then-issue with two taps?

**Recommendation: the two-step flow (draft → issue, each human-approved) is the trust-correct
reading.** One utterance + one tap yields an approvable draft; a second utterance ("issue it") +
tap issues it. Rationale: `issue_invoice` makes a customer-visible, money-bearing document out of
a draft; the repo's own action-class ladder (`actionClassForProposalType`) and the D-013 posture
(approval is never voice-reachable) both treat "make it real" transitions as human-gated. A
single-utterance auto-issue-on-approve behavior would be a NEW capability with its own risk
review (auto-issue implies the approval tap is doing double duty), and is explicitly not built in
Phase 1.

**Scoring consequence (per master prompt):** B9.1 scores rung 5 in the re-measurement only if
this entry is ratified as the two-step reading AND the issue-leg proof (cross-tenant negative)
exists. If the product owner instead demands single-utterance issuance, B9.1 stays red until that
is built, and the run target drops by one — reported honestly.

## F-2 · B1.18 lock-as-tap amendment — PROPOSED (awaiting ratification)

**Question:** B1.18's text reads "brand voice captured, then locked." Phase 1 makes capture
speakable. May "locked" be satisfied by the existing tap-only lock?

**Recommendation: yes — amend B1.18 to "captured by voice; locked by tap."** Lock is a control
act that freezes the tenant's outbound identity; the same theory as D-013's approval exception
(control acts stay off the voice surface). The run ships a negative test pinning that a spoken
"lock my brand voice" can never set `brand_voice_locked`.

**Scoring consequence:** B1.18 scores rung 5 only if this amendment is ratified. Rejected →
lock-by-voice becomes an implied build (its own risk review — an utterance that irreversibly
freezes config), B1.18 stays red, target drops by one — reported honestly.

## F-3 · B5.5 "on my way" as a direct audited status act — RECORDED

Voice and SMS legs of "on my way" invoke the **same audited direct status act** as the shipped
app button (en-route coordinator → `appointment.en_route_triggered` audit → branded, DNC-gated
ETA SMS) — **not** a proposal. Rationale (stated fully because a reviewer challenged it): A5.2's
invariant governs AI-*proposed* actions; a technician saying "on my way" is the human acting
directly — the precedent PRD B10.10 already blesses ("the owner IS the human": direct + audited
+ DNC-gated), and the app button already executes this act directly. What voice adds is
classification risk, so: a low-confidence `en_route` classification gates to clarification
(confidence-floor test), the intent lives in the documented non-proposal set exactly as
`lookup_*` does (B7.11's drift test recognizes it as intentional), and no new `JobStatus` value
is introduced. Fallback if the held-commit reviewer rejects this rationale: an auto-approvable
capture-class proposal — a human call at review time, not a reason to stall the run.

## F-4 · B7.5 spoken parts land on billing documents — RECORDED

"Add three capacitors to the Smith estimate" lands structured `{name, quantity, unit}` lines on
the job's active **billing document** (estimate/invoice) via the proven line-item edit path —
that is what the sentence means. A separate job-materials table (parts not on any billing
document) is a **Part F candidate for a future phase**, not built now. No auto-created estimate
in this run: a spoken part with no open target document gates honestly (`missingFields`) with the
structured parts preserved on the draft, so nothing spoken is lost.

## F-5 · B1.19 wizard remains the default onboarding surface — RECORDED

The conversational onboarding step ("talk it through") is added to the v2 `OnboardingShell` as an
opt-in step; the form wizard remains the default fallback and the edit surface. B1.20's
soft-gate guard tests stay green unchanged.

## F-6 · Deferred-set integrity — RECORDED

B7.8, B7.10, B9.12, B9.4, B7.9, the boot-guard default-fail (C2), and the live-call UTC datetime
fix (Part E punch-list #1) remain deferred per the master prompt. C1 covers the deferred intents
by pinning their current honest-gating behavior — pins, not fixes.
