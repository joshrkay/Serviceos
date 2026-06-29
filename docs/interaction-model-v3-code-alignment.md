# Interaction Model v3.0 ⇄ Code Alignment

**Date:** 2026-06-22  
**Baseline:** `docs/interaction-model-v3.md` (v3.0)  
**Purpose:** Map §19 acceptance criteria and key behavioral contracts to the current build. Use this when scoping stories — if behavior contradicts the interaction model, the model wins.

---

## Headline

The **proposal + confidence + undo + one-tap** spine already implements much of v3's execution lanes and action lifecycle. The largest gaps are **standing instructions as a first-class settings surface**, **bandwidth-aware deferral**, **lane-1 auto-execute on standing rules** (today most paths still tee up), and **leverage metrics** (actions-per-direction).

---

## §19 Acceptance criteria

| Criterion | Status | Evidence / gap |
|-----------|--------|----------------|
| Leverage measured (actions per direction) | **Gap** | `chainId` multi-action decomposition exists (`packages/api/src/routes/assistant.ts`, `proposal.ts`) but no product metric for actions-per-direction or debrief fan-out. |
| Command preserved — no customer-facing without direction or standing instruction | **Partial** | Money/comms proposals gated (`one-tap-approve.ts`, `proposals/sms/render.ts` RV-071); inbound booking can commit on call. **Standing instructions not modeled** — booking rules live in tenant settings but not as editable "mandate" list. |
| Standing instructions visible, editable, revocable | **Gap** | No `standing_instructions` entity or settings UI. Booking hours/area/services are config fragments, not the v3 contract. |
| Instant surfaced undo on standing-instruction / one-tap actions | **Partial** | 5s post-approval undo window (`proposal.ts` `UNDO_WINDOW_MS`, `routes/proposals.ts` `/:id/undo`, execution worker). UI surfacing varies by surface; not unified "Done — undo?" on all lanes. |
| Inbound voice ≤1.5s; back-office <3s p50 | **Partial** | Media Streams path exists; latency not continuously gated in CI. PTT back-office is upload→transcribe→classify (not <3s p50 today). |
| Mic reachable every route; ≥44px (≥56px primary); no 320px overflow | **Partial** | `VoiceBar` on key routes; primary mic is `size-7` (28px) — **below contract**. Portal/mobile tests pin `min-h-11` on CTAs. |
| Confidence tier + per-line provenance on teed-up actions | **Partial** | `confidenceScore` / `confidenceFactors` on proposals; catalog resolver emits `catalog` / `uncatalogued` / `ambiguous` (`estimate-clarification.ts`). UI coverage incomplete (P2-035). |
| Uncatalogued lines never auto-price | **Built** | Catalog resolver + clarification path; low/very_low blocks one-tap SMS (`daily-digest-worker.test.ts`). |
| Clarifications: missing/ambiguity only, capped, picker-preferred, bandwidth-deferred | **Partial** | Estimate clarification + entity resolver pickers exist. No global 3-loop cap; **no bandwidth/moment deferral** to end-of-day. |
| Schedule & message 48h expiry (re-surfaceable) | **Partial** | `defaultProposalExpiry` + expiry worker for schedule types (`proposal.ts`, `proposal-expiry-worker.ts`). Re-surface path in `routes/proposals.ts`. Distinct scheduled-message type not built (model allows comms to persist). |
| Every mutation audited | **Built** | Audit events on proposal approve/execute/undo; assistant actions carry `createdBy` / `aiRunId`. |
| Corrections → digest → standing-instruction offer | **Partial** | Correction loop + digest (`learning/corrections/*`, `digest-builder.ts`). Digest does not yet offer "handle this automatically?" → standing instruction. |
| Customer token links, SMS confirm | **Built** | Portal routes, one-tap approve, public booking/estimate flows. |

---

## Behavioral sections ⇄ implementation

### Execution lanes (§5)

| Lane | Today | Gap |
|------|-------|-----|
| Act on standing instruction + undo | Trust-tier auto-approve for capture-class proposals at high confidence | Not framed as standing instructions; owner cannot see/revoke per-class mandate |
| One-tap teed up | Proposal inbox, SMS one-tap, dashboard approve | Primary path — aligned |
| Decision required | Money/comms/irreversible types | Aligned (`MONEY_PROPOSAL_TYPES`, RV-071) |
| Owner-only always | Stripe charge, binding sends | Aligned |

### Universal loop (§7)

- **Interpret:** voice → assistant route → classify/extract (`routes/assistant.ts`).
- **Entity resolve:** `packages/api/src/ai/resolution/*`.
- **Lane select:** confidence + proposal type + threshold resolver.
- **Defer on low bandwidth:** not implemented.

### One-breath debrief (§8)

- **Multi-intent:** `chainId` decomposition in assistant route; sequential linked proposals.
- **Fan-out to lanes:** each proposal gets its own confidence/lane — partial.
- **Job complete + inventory + payment in one breath:** depends on action handlers wired; inventory auto-deduct (P14) not fully built.

### Voice state machine (§12)

- Launch ships **PTT** per `docs/launch/voice-interaction-scope.md` — phases map to `VoiceBar` (`idle` → `listening` → `transcribing` → `sending`).
- Live partial transcript, barge-in, streaming: **post-launch**.

### Inbound call (§13)

- FSM in `ai/agents/customer-calling/*`; Twilio adapter; emergency escalation; dropped-call SMS recovery.
- **One-tap-as-executed booking** on live call: booking proposal flow with owner review card — aligned in spirit.
- Standing booking rules: tenant hours/service area — not unified standing-instruction UX.

### Learning loop (§17)

- Corrections recorded; digest reports "what I learned."
- **Missing:** digest prompt to convert pattern → standing instruction.

---

## Recommended story themes (not in this PR)

1. **Standing instructions** — settings model, list UI, lane-1 executor hook, digest conversion prompt.
2. **Bandwidth / moment** — context signal (route, session) → defer clarifications to EOD batch.
3. **Leverage metrics** — `chainId` cardinality + executed count per direction id.
4. **VoiceBar tap target** — primary mic `min-h-14 min-w-14` (56px) + contract test.
5. **Unified "Done — undo?"** — post auto-execute card on voice + SMS surfaces.

---

## Precedence reminder

Behavioral conflicts: **`interaction-model-v3.md` wins.** Feature existence: **`PRD-v3.md` wins.**
