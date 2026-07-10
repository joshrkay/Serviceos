# Rivet PRD v3.x ⇄ Code — Current Status

**Date:** 2026-06-20
**Baseline:** `docs/PRD-v3.md` (v3.2, reconciled 2026-06-14) — the canonical, code-aligned,
actively-maintained PRD. This **supersedes** the uploaded *AI Service OS v4.1* lineage (pre-rebrand
vision doc) as the comparison baseline; the story-level evidence in `docs/prd-v4.1-feature-diff.md`
remains valid but was measured against the wrong (older) doc.

## Why this exists
We re-ran the comparison against the **most recent** PRD (v3.x), not the original upload. Two
things fall out: (1) several capabilities I'd flagged as "outside the PRD" against v4.1
(memberships, portal, reputation) are **first-class in v3.x and built**; (2) v3.x's own status
tracking **under-counts** the build — QuickBooks sync and the correction loop are shipped but
still marked "Specced."

---

## Headline
Against the current PRD, **the core product is built.** v3.x's §5 parity map (40 workflows) is
mostly ✅, and its §8 roadmap is stale — much of Phase 1–3 has already merged. The genuinely
remaining work is a **short, mostly "finish-the-wiring" list plus Phase-3 depth features.**

---

## ✅ What we have (built & wired — validated today)
Per §5 (reconciled 2026-06-14) **plus two corrections from today's check**:

- **Inbound voice loop** — Twilio Media Streams answer → classify → entity/account match →
  slot + drive-time feasibility → booking proposal → SMS one-tap approve → confirmation; dropped-call SMS recovery.
- **Back-office voice** — schedule/revenue/lookup queries; voice invoice; voice assignment/reschedule.
- **Scheduling & dispatch** — conflict detection, drive-time feasibility, voice assignment,
  "I'm out" cascade reschedule, "on my way" → ETA SMS.
- **Estimating** — voice-drafted, catalog-priced line items, good/better/best tiers, portal
  approval + e-signature + Stripe deposit on accept; unsold-estimate follow-up cadence.
- **Invoicing & payments** — auto-invoice on completion, voice invoice, Stripe payment links,
  dunning cadence, auto-accruing late fees.
- **Memberships** — auto-renew (`off_session`), member pricing, priority booking. *(in v3.x §6.7)*
- **Client Hub** — lightweight token-gated portal (approve + pay, no login). *(in v3.x §6.10)*
- **Reviews & reputation** — post-job review-request gating (4★→Google), GBP monitoring, AI
  public-response + private-apology drafting. *(in v3.x §6.11)*
- **Trust layer** — typed proposals + approval + audit + undo; supervisor second-pass review;
  negotiation guardrail; brand-voice validation; confidence markers.
- **End-of-day digest** — daily SMS P&L + "what I wasn't sure about" + "what I learned."
- **Correction loop** — owner edit → lesson extracted → forward-applied → reported in digest.
  ⟵ **correction to §5** (`learning/corrections/*` wired in `proposals/actions.ts`, `digest-builder.ts`).
- **QuickBooks one-way sync** — paid invoices → QBO, leader-elected `accounting-sync-worker`.
  ⟵ **correction to §5** (wired in `app.ts`; shipped ahead of its Wave-3 slot).
- **Platform invariants** — integer cents, UTC, tenant RLS (FORCE), audit on mutations, LLM gateway,
  catalog-grounded pricing.

---

## 🔧 / 📋 What's still to be done (refreshed against today's code)

### Finish-the-wiring (Partial today)
| Item | State | Ref |
|---|---|---|
| MMS-to-quote (plumbing) | photo ingest only; **image→estimate analysis not built** | §5, §6.4-B |
| ACH payments | card + payment links live; **ACH not configured/exercised** | §5 |
| B2B account recognition | binary residential/b2b flag; **no PM type, sub-accounts, or routing** | §5, §6.6 |
| Confidence markers (P2-035) | shipped, complete the surface coverage | §8 P1 |
| Brand-voice configurator (P4-015) | validation works; full onboarding config UI pending | §8 P3 |
| Vulnerability-aware triage (N-008) | detection present; full elevation flow pending | §8 P3 |
| Native mobile | PWA built; **Capacitor native on roadmap** | §5 |
| 48h proposal-expiry default | `expiresAt` field + check exist; **no creation path sets the TTL** | §6.14 |

### Specced — not built (Phase 3 depth)
| Item | Story |
|---|---|
| Equipment registry (HVAC unit history) | P24 |
| Truck inventory (parts auto-deduct → invoice) | P14 |
| Per-job profit by voice (costing layer) | P22-005 |
| Tip capture · tap-to-pay (Stripe Terminal) | P22 |
| Offline voice capture (Capacitor spike) | — |
| **Voice-overage metering / billing** (flat $297 + $0.30/min model) | — *(monetization — the one revenue-relevant gap)* |

### Deferred (post-PMF / Wave 3+)
Consumer financing (Wisetack) · full route optimization · custom job-form builder · full
self-service customer portal · multi-location / team hierarchies.

### Go-Live hardening (§8 "Now") — largely addressed
RLS FORCE, durable webhook dedup, leader-elected sweeps (`runAsLeader`), and payment audit events
appear shipped per recent commits. Recommend a final confirm pass on transaction-rollback-on-error
and the approval-endpoint auth check.

---

## Recommended cleanup (fights doc sprawl)
1. **Update v3.x §5** (via the D-0xx protocol in §14): QuickBooks sync ✅, Correction loop ✅.
2. **Refresh §8 roadmap** — mark shipped: P2-034, P2-035, P5-020, P7-026, P2-036, supervisor
   agent, Media Streams, auto-invoice/dunning, QB sync.
3. **Label the v4.1-lineage docs** (`prd-v4.1-feature-diff.md`, the upload) as superseded-baseline
   so future comparisons use v3.x.
