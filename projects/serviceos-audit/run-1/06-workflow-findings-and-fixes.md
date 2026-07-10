# Track A4/E — Workflow Findings, Verification & Fixes (run-1)

The discovery workflow's **fresh-context per-surface auditors** dug into *reachability and
consumption* (not just "does the code exist"), surfacing defects the orchestrator's first-pass
audit missed. Each is triaged here: CONFIRMED (verified by independent code-read) → fixed or
documented; REFUTED (the auditor over-claimed; the code actually handles it). Auditors over-report
severity, so every high/critical was re-verified before any action (Guardrail 3).

## Fixed this run (confirmed → fix → test → commit)

| # | Finding | Verified | Fix (commit) |
|---|---|---|---|
| F1 | **Brand-voice banned phrases** enforced only as a soft prompt hint, no code check | CONFIRMED (orchestrator) | `be185d4` `enforceBannedPhrases()` + 8 tests |
| F2 | **Reputation private follow-up SMS bypasses DNC/consent entirely** (TCPA risk) — handler→adapter→Twilio, no gate at any layer while every other SMS path gates | CONFIRMED (traced full chain: `review-response-handler.ts:255` no gate, `TwilioDeliveryProvider` no gate) | `fb244ba` DNC+consent gate in adapter, suppression as explicit result variant + 4 tests |
| F3 | **Google review responses ignore brand voice** — `NoopBrandVoiceLoader` (returns NEUTRAL) wired into review drafting; P4-015 stub never swapped | CONFIRMED (`app.ts:1741`, no real loader existed) | `8ec0d20` `SettingsBrandVoiceLoader` reads tenant tone + banned phrases + 4 tests |
| F4 | **QBO sync drops paid invoices beyond the newest 200** per tenant — fixed `limit:200` fetch, no pagination | CONFIRMED (`findByTenant` = `created_at DESC LIMIT 200 OFFSET 0`; offset supported but unused) | `42c0740` paginate all paid invoices + 5-invoice/2-page regression test |
| F5 | **PgQueue depth never emitted** — committed C1 SLO + P2 alert unobservable | CONFIRMED (only `ws_queue_depth` existed) | `dbcaf94` `pg_queue_depth` gauge + leader-elected sampler + tests |

## Refuted on verification (auditor over-claimed — code holds)

| Finding | Verdict | Why |
|---|---|---|
| "Web estimate route never catalog-resolves prices → **money-invariant violation**" (`routes/estimates.ts:780`) | **REFUTED** | The handler treats *all* prices as uncatalogued when no catalog is wired (`estimate-task.ts`: "even with no catalog wired… every LLM price is treated as uncatalogued so the confidence cap below still fires") and caps confidence below auto-approve ("an AI-invented price must never ride a ≥0.9 confidence score into autonomous auto-approval"); the route also forces `status:'draft'` (`estimates.ts:799`). The Guardrail 2 invariant HOLDS. (Minor quality nicety: web suggestions could be catalog-*grounded* like voice — non-safety, low priority.) |

## Confirmed / pending final verification (documented; large or requiring product decision)

These are **persona-fit / "built-but-not-reachable"** gaps — real per the reference standard, but
several need frontend/UI or notification wiring beyond a surgical code fix, so they are documented
with the recommended fix rather than force-patched in this run (Guardrail 5 — strong 80%, note what
is cut). The adversarial verify phase's verdicts are folded in as they complete.

| Finding | Category | Recommended fix | Scope |
|---|---|---|---|
| Conversational onboarding lane has no UI/voice/SMS entry point (backend FSM exists, unreachable) | persona-fit | Wire a web/mobile onboarding-conversation surface to `POST /api/onboarding/conversation/turn` | large (frontend) |
| Onboarding `onboarding_*` proposal types may lack execution handlers | correctness | Register execution handlers or confirm the settings-persist path is the real terminal | needs verify |
| `review_response_proposal` per-component approval flags never set by any UI | correctness | Add owner-facing approve toggles (mobile inbox) | medium (UI) |
| Dunning cadence + late-fee policy have no tenant write path (hardcoded default) | persona-fit | Settings write path + configurator UI | medium |
| Auto-invoice-on-completion defaults OFF, no UI to enable | persona-fit | Settings toggle + onboarding default decision | small-medium |
| Painting/Electrical packs unreachable (onboarding schema hardcodes hvac/plumbing) | persona-fit | Widen `PackPickInputSchema` enum + settings/catalog seed | small |
| B2B priority-routing context computed but never consumed on the live call | persona-fit | Consume `ctx.priority` in the voice turn/routing | medium |
| `high_priority_booking` triage decision doesn't notify owner | correctness | Wire the decision to the owner-notification path | small-medium |
| Tech ETA texts are a static scheduled window; GPS lateness engine (`dispatch/lateness.ts`) is unreferenced | correctness/dead-code | Either wire the GPS engine to ETA texts or remove the dead module (CLAUDE.md) | medium |
| Zod-contract safety gate is opt-in per call site, not structurally enforced | correctness | Enforce validation in `createProposal` for AI-drafted types | medium |
| Brand-voice configurator (owner write path for the tone contract) does not exist | persona-fit | Settings write path for `brand_voice` JSONB + UI | medium |

**Note on severity:** the auditors tagged several of these "critical," but a backend capability that
is real yet not surfaced in the UI is a **product-completeness gap**, not a runtime
correctness/security critical. The genuine runtime defects (F2 DNC bypass, F4 QBO data loss) were
fixed. No confirmed tenant-isolation, money-movement, or auth **critical** remains open.
