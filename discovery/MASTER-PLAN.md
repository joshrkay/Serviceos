# MASTER PLAN — ServiceOS ("Rivet") Discovery & Planning Synthesis

Date: 2026-07-18 · HEAD `a9d06aa` · Read-only audit; plan only, no code changed.
Sources: `discovery/00-cartography.md` and track docs `01`–`06`. Item IDs below reference track findings (`Tn-Fnn`) where full evidence lives; new synthesis-level items get `GAP-nnn` / `REF-nnn` IDs.

---

## Headline: reality vs. the operator brief

The brief's operating model of this codebase (§3) is substantially stale. What actually exists is **larger, more mature, and differently built** than claimed:

| Claim | Reality | Where verified |
|---|---|---|
| Next.js App Router | React 18 SPA (Vite, react-router 7) + Express API. Next.js existed only in the removed `/experiments` prototype (D-016). | 00, 03 |
| Supabase (Postgres + pgvector) | Raw Postgres on Railway + PgBouncer; RLS done natively; pgvector *is* in the prod schema (`knowledge_chunks`). Supabase appears only as an optional host for the inert training pipeline. | 00, 05 |
| Vapi as the voice stack | Twilio (Gather + Media Streams) + Deepgram + ElevenLabs is the real stack. Vapi integration is live but deliberately shallow (session logging + activation; no appointment paths). | 00, 02 |
| Production `/goal` prompt suite | **Does not exist** — not in tree, not in git history. Prompts are disciplined inline constants. | 01 |
| ~305 labeled utterances, ~60 transcripts | 6,651 labeled rows + 305 generated transcripts (the "305" claim conflates the two). But the corpus file is schema-broken and its manifest is materially false. | 06 |
| Agent-behavior model | Two competing YAML taxonomy documents, both stale vs prod, enforced nowhere at runtime. | 06 |
| Chromatic/Storybook | Not present. Testing is Vitest + Playwright + a five-workflow voice-quality CI stack. | 00, 03 |
| Four functional areas | The four exist — plus an entire field-service back office (jobs/estimates/invoices/payments/dispatch/portal/mobile) the brief didn't mention, which is most of the code. | A below |

The overall engineering quality is **well above typical for this stage** — tenant isolation, the proposal safety layer, webhook security, and the money-grounding chain are genuinely hardened. The systemic weaknesses are: (1) **the evidence layer for AI behavior is thinner than it looks** (the PR/deploy gates never call a real LLM; the offline corpus/eval stack is broken-in-place); (2) **real-time latency misses the natural-conversation target by 2–3×** by construction; (3) **three scale-event landmines** (full-corpus DDL on every deploy, no retention on the three fastest-growing tables, single-replica in-memory voice state) sit directly on the 1,000-concurrent-session path.

---

## A — Feature Inventory

Maturity: **Prototype** (exists, unproven/unwired) · **Working** (functions, gaps in proof or polish) · **Hardened** (defended in depth + tested). Evidence in the referenced track docs.

### A1. Onboarding / conversion funnel — **Working→Hardened**
- 7-step self-serve wizard (signup → identity → vertical pack → Twilio phone provisioning → Stripe billing → ElevenLabs voice config/AI check → test call), server-derived resume, funnel analytics with dedup (`packages/web/src/components/onboarding/v2/`, 2,907 LOC). [03]
- Onboarding conversation agent: FSM + 5 LLM extractors (business profile / pricing / schedule / team / templates) → human-reviewed proposals. **Working** — raw LLM prices seed the future catalog with only human review as the gate (T1-F14). [01]
- FUNNEL.md event contract drifted from code (T3-F13); PostHog off-by-default — live emission unverified. [03]

### A2. Customer-facing AI CSR (inbound calls) — **Working overall; Hardened plumbing, unproven audio/latency edge**
- Two transports, one pure-reducer FSM: Twilio Gather (default) and Media Streams→Deepgram realtime with per-tenant rollout, health circuit, and mid-call degrade back to Gather. Signature coverage complete incl. WS upgrade (T2-F15). [02]
- Intent classifier: 60 intents, versioned taxonomy, deterministic overrides, enum-drift telemetry — **Hardened**. Money grounding (catalog resolver → confidence cap → quote readback that never speaks an LLM-invented number) — **Hardened**, best-engineered part of the product. [01]
- Escalation: whisper transfer, dispatcher dial cascade, call-me-back, voicemail fallback, dropped-call recovery worker — **Working→Hardened**. [02]
- Edges that undercut it: possible static-audio defect on the streaming TTS path (T2-F01), 1.5–2.9s dead air per turn (T2-F02/F11), silent callers hung up (Gather, T2-F03) or stranded (Media Streams, T2-F05), negotiation/complaint guardrails unreachable for customers (T1-F02), quota exhaustion spoken as "didn't catch that" (T1-F08).

### A3. Operator-side voice OS — **Working (~80% of the claim is real)**
- Real streaming dictation: browser WS → Deepgram with server-minted 30s grant tokens (key never in browser), barge-in conversation loop, resilient WS gateway client, supervisor session wall. [03]
- Assistant chat + inline proposals with server-anchored 5s undo; proposal inbox **Hardened** (batch approve gated to capture-class ≥0.8 confidence; money/comms excluded). Dispatch board **Hardened** (drags → proposals with optimistic concurrency + idempotency; SSE + watchdog + presence fallback). [03]
- Not wired: assistant token-streaming protocol defined but unused — every utterance waits a full POST round trip (T3-F07). Mobile PTT/offline story absent (PWA is shell-only, T3-F11).

### A4. Voice corpus / comprehension layer — **Prototype / broken-in-place (harness: Hardened)**
- Five-workflow eval CI (PR Layer-1 cassette gate, nightly, weekly live model eval, release Layer-2 real-audio voting, daily real Twilio smoke) — **Hardened architecture**, but the PR/deploy-path gates are LLM-free (T1-F01) and the corpus layer beneath is broken: mixed-schema corpus file (T6-F01), zero corpus gates in CI (T6-F02), triple taxonomy drift with a ~9.6pp structural error floor under the live 92% gate (T6-F03), Spanish effectively un-gated (T6-F05), manifest materially false (T6-F06). [06]
- Reddit/pgvector training pipeline: well-built island, zero consumers (T6-F07). 1,610-term domain vocabulary: zero runtime consumers (T6-F08).

### A5. Back-office core (not in the brief; most of the product) — **Working→Hardened**
- Jobs / estimates (tiered good-better-best) / invoices / payments (Stripe + Connect + Terminal + ACH lifecycle) / recurring jobs with idempotent materialization / agreements / maintenance contracts / dispatch / time tracking / expenses / job forms / custom fields / financing (Wisetack, env-gated) / email campaigns / reviews & reputation / customer portal / public estimate-approval & pay pages (**Hardened** — best Stripe edge-handling in the repo) / SMS negotiation & recovery flows / daily digest / tax export. [03, 04]
- Proposal execution layer: draft → approve (web/one-tap/SMS) → 5s undo → per-type handlers → audit; D-015/D-018/D-019 narrow autonomous lanes. **Hardened** with one caveat: external-I/O handlers depend on per-handler self-guards for crash idempotency (T4-F08).
- Owner mobile app (Expo, 181 files) — **Working**, mid-MVP, not at web parity. [03]

### A6. Platform — **Hardened with named exceptions**
- Multi-tenancy: 116/124 tables FORCE RLS + runtime non-BYPASSRLS role enforced at boot + PgBouncer-safe SET LOCAL + four PR-gated integration suites. **The strongest subsystem in the repo.** [05]
- LLM gateway: tier routing, per-tenant quotas, breaker, deadlines, micro-cent cost accounting, `ai_runs` audit — **Hardened**; but failover is a no-op (one provider, T1-F07) and response caching is off by default (T1-F11).
- Webhooks (Stripe/Clerk/Twilio/SendGrid/Vapi): signatures + replay windows + durable idempotency — **Hardened**. [04]
- Workers: 35 sweeps, PgQueue (SKIP LOCKED, DLQ, orphan reaper), advisory-lock leader election, SLO monitor — **Working→Hardened**; mark-after-send SMS family is the weak spot (T4-F01).
- Observability: structured redacting logs + prom metrics + SLO pager — **Working**; but 500s never reach Sentry and correlation IDs die at the queue boundary (T4-F03).

### Claimed features not found
- `/goal` prompt suite — not found (tree + git history). [01]
- Chromatic/Storybook — not found. [00, 03]
- "Agent-behavior model" as a model — not found; YAML taxonomy docs only. [06]
- Next.js/Supabase production stack — not found (removed prototypes only). [00]

---

## B — Competitive Gaps

Benchmarks: Jobber/Housecall Pro (primary head-to-head at the 1–5 tech ICP), ServiceTitan (graduation risk), Avoca.ai (AI-receptionist add-on; raised Series B, SOC 2 II, ServiceTitan integration). The repo's own `docs/competitive-gap-analysis.md` (2026-06-10, partially executed since) is directionally sound; items below reconcile it against what the audit found actually built. **[TS] = table-stakes, [DB] = differentiation bet.**

**GAP-001 [DB] Complete the booking during the call.** The flagship demo — caller hangs up with a confirmed slot, no human tap — is still gated on supervisor presence for ordinary tenants; D-015's autonomous lane exists but the in-call completion path is the pitch and isn't the default experience. Avoca's entire category answers-and-books; Jobber's AI Receptionist hands off to humans. Everything needed (FSM, slot conflict checks, proposals, undo, SMS confirm) exists. Depends on: FIX wave 1 (latency + silence handling — a booking agent that hangs up on silent callers can't be the flagship). Effort M. Confidence High. [02, repo docs R1/P12]

**GAP-002 [DB] Sub-second voice turns.** Current design misses 0.5–1.0s by 2–3× (T2-F02/F11/F14). Voice-AI competitors live and die on this; it is the single most perceptible quality signal on a phone call. Plan: filler-at-final-transcript → speculative classification on stable interims → streamed first-sentence TTS; measure with the (fixed) load/latency harness. Effort M-L (sequenced fixes, not a rewrite). Confidence High.

**GAP-003 [TS] Spanish end-to-end.** The voice agent sells Spanish calls; the customer then receives English-only estimate/pay/portal pages at the money-conversion moment (T3-F03), and Spanish model behavior is essentially un-gated (T6-F05). For HVAC/plumbing SMBs this is a large addressable slice. Plan: es catalogs for the ~7 public money surfaces keyed off captured `preferredLanguage`; wire `utterances_es.jsonl` into the live weekly gate. Effort L (split S/M chunks). Confidence High.

**GAP-004 [DB] Catalog-priced voice invoicing.** "Add a service call and three gaskets" must yield SKU-priced integer-cents lines, not free text. Repo docs flag it (R2); Track 1 confirms the grounding chain exists for quotes but invoice-edit drafting lacks catalog context injection. This is buy-reason #2 ("get paid without typing"). Effort M. Confidence Med-High (invoice-task internals partially audited).

**GAP-005 [TS] Email deliverability hygiene.** SendGrid bounce/complaint events are recorded and discarded (T4-F11) — no suppression list. Every competitor suppresses; continuing to mail hard-bounces degrades sender reputation for *all* tenants (shared sending domain blast radius). Effort M. Confidence High.

**GAP-006 [DB] Operator voice UX: streaming + mobile PTT + offline capture.** Assistant streaming protocol exists but unwired (T3-F07); no push-to-talk in the mobile shell; PWA has no offline data/queue (T3-F11) — while the ICP works in basements. Jobber's Copilot is chat-in-app; voice-first is the stated wedge, so the wedge must actually be ergonomic. Effort L (staged). Confidence High.

**GAP-007 [TS] Provider redundancy for the AI dependency chain.** One LLM provider (failover list never populated, T1-F07), one STT vendor, one TTS vendor, with no modeled account-concurrency limits (T2-F04). Avoca-class competitors run multi-provider. An LLM outage today = every call escalates to a human at once. Effort M. Confidence High.

**GAP-008 [TS] Trust/compliance artifacts.** Avoca markets SOC 2 Type II. Nothing in-repo evidences a compliance program (no policy docs, no audit-log retention policy — indeed transcripts/AI snapshots retain PII forever, T5-F02/T1-F09). For selling to even small shops via partnerships, SOC 2 readiness + a written retention policy is becoming table-stakes. Effort XL (org-level; the repo work is the retention/PII items in C). Confidence Med (business posture partly outside repo).

**GAP-009 [DB] Truck inventory / equipment records / per-job profit by voice.** Confirmed absent in code (matches repo docs G3/G4/G5); these are the "grow-with-you" moat items vs Jobber (which lacks inventory entirely). Sequenced after the promise-breaker gaps. Effort L each. Confidence High.

**GAP-010 [TS] QuickBooks sync depth.** D-013 marks manual-trigger sync Built; competitive parity requires reliable automatic sync (accountant is buy-reason #4). Not independently audited this pass — flagged for a focused follow-up rather than asserted. Effort M. Confidence Low (unverified).

---

## C — Fix List (force-ranked)

Full evidence + plans live in the track docs; this is the ranked register. Blast radius drives rank: AI-interaction breakage > tenant/PII exposure > scale collapse > money correctness > UX.

### Critical
| ID | Finding | Why it leads | Effort |
|---|---|---|---|
| T2-F01 | ElevenLabs streaming output format never pinned; adapter assumes PCM — **default verified 2026-07-18 as `mp3_44100`** (ElevenLabs API reference + elevenlabs-python #251), so the realtime path emits MP3 into a PCM decoder; no gate would catch it | Near-certain static on any Media-Streams turn; fix is a one-line `output_format=pcm_16000` pin + first-chunk guard | S |
| T1-F01 | The AI quality gate on the deploy path never calls an LLM (mock echoes expected intents; judge hardwired to pass); real-model evals are weekly/release-only | Every prompt/model change ships to prod on plumbing-only evidence | M |
| T6-F01 | Corpus file holds 4,854 mixed-schema rows; Python eval + both validators + dedup all crash/fail | The comprehension layer's ground truth is broken-in-place | M |
| T6-F02 | Zero corpus/PII/dedup/eval gates in CI — which is why F01 shipped silently | Restores the feedback loop that prevents recurrence | S |
| T6-F03 | Taxonomy triple-drift (prod 60 / behaviors 41 / corpus 35); 9 impossible labels ⇒ ~9.6pp structural floor under the live 92% gate; 18 prod intents have zero eval coverage | The one real-model gate is structurally red or being ignored | M |

### High
| ID | Finding | Effort |
|---|---|---|
| T2-F03 | Gather: silent caller falls through `<Gather>` → Twilio hangs up (no `actionOnEmptyResult`) | S |
| T2-F05 | Media Streams: no per-turn silence timer — silent caller waits forever | S |
| T2-F02 | Filler audio armed after the LLM call — 1.5–2.9s dead air per turn | M |
| T1-F02 | Negotiation/complaint guardrails unreachable on customer calls (gated on `ownerSession`) | S-M |
| T1-F03 | No injection detection on caller→LLM path; dead `prompt_injection_detected` event; guard drift across prompts | M |
| T1-F04 | Auto-approve confidence is the model's self-reported score | S-M |
| T4-F01 | Duplicate-SMS window: mark-after-send sweeps backstopped by an unverified Twilio idempotency header | M |
| T4-F02 | Prod `/api` per-IP limit 100 req/15min — office NATs will 429 in minutes | S |
| T4-F05 | `/webhooks` 30 req/min per IP — Twilio callbacks 429 at moderate scale; lost inbound SMS | S |
| T4-F03 | 500s never reach Sentry; correlation ID dies at the queue boundary — cannot trace a call voice→API→worker | M |
| T4-F04 | `POST /api/proposals`: no `requirePermission`, `payload: any` | S |
| T4-F06 | `TENANT_ENCRYPTION_KEY`/`TRANSCRIPT_ENCRYPTION_KEY` not boot-validated, absent from env examples; two divergent config validators | S |
| T5-F01 | Every deploy re-runs the full 6,316-line DDL corpus (46 constraint re-validations, ~116-table lock churn) under a 25s timeout — deterministic deploy failure as tables grow | L |
| T5-F02 | No retention/partitioning on `ai_runs`/`audit_events`/`call_transcript_turns`; transcripts + full LLM I/O (PII) retained forever (subsumes T1-F09) | L |
| T5-F03 / T4-F09 | Request transaction held across Stripe/Twilio/Google awaits vs 25-backend PgBouncer budget | M |
| T2-F04 | Hard single-replica voice ceiling; capacity literally "TBD"; 1,000-concurrent unreachable & unvalidated | XL |
| T2-F06 | Voice load-test harness cannot exercise the real adapter (unsigned WS → 403; start frame → 1008) — blocks measuring T2-F04 | S |
| T3-F01 | Web unit tests mock the network (38 files); the real-API e2e suite self-skips without full provisioning — contract drift invisible | M |
| T3-F02 | `serviceos.*` localStorage unscoped, survives sign-out (permissions cache, drafts, technician impersonation override) | S |
| T6-F05 | Spanish un-gated in every live eval | M |
| T6-F06 | CORPUS_MANIFEST.md materially false (counts, provenance, PII assertions, "byte-identical regeneration") | S |
| T6-F07 | `serviceos_training/` island — decide: wire or archive | S(decide)/L(wire) |

### Medium (selected; full lists in track docs)
T2-F07 tenant WS-cap kills 51st call with no Gather fallback (S) · T2-F08 /gather turn not idempotent under Twilio retry (M) · T2-F09 barge-in on any interim incl. background noise (M) · T2-F10 STT/TTS keys in WS URLs (S) · T2-F11 600ms endpointing floor (M) · T2-F12 TTS recovery step 1 dead with ElevenLabs; filler cache accepts mp3-as-PCM (S) · T2-F13 no CI proof of realtime path against real providers (M) · T1-F05 prompt versioning vestigial (M) · T1-F06 session cost cap uses hardcoded price guess (S) · T1-F08 quota exhaustion spoken as "didn't catch that" (S-M) · T1-F10 graders: prompt+transcript in one user message, silent zero on failure — vulnerability grading fails open invisibly (S) · T4-F07 appointments PUT mass-assignment + status-update siblings (S) · T4-F08 external-I/O handler self-guard audit (M) · T4-F10 DLQ loses real error (S) · T4-F11 SendGrid suppression (M, also GAP-005) · T4-F12 idempotency on charge-adjacent/call-initiation POSTs; silent audit catch (M) · T4-F13/T5-F08 DB TLS `rejectUnauthorized:false` (S) · T5-F04 swallowed migration rollback boots stale schema (S) · T5-F05 money CHECK constraints missing (S) · T5-F06 `webhook_events`/`tenants` readable by runtime role (S) · T5-F07 queue claim-path index + DLQ pruning (S) · T5-F11 schema drift undetectable (M) · T3-F05 portal tests are CSS tripwires (S) · T3-F06 signature canvas has no keyboard/AT path (S) · T3-F09 raw error messages shown to customers (S) · T6-F10 cassette staleness informational-only (S) · T6-F11 slot gold thin; service_type/phone have no live gate (M).

### Low
T4-F14 Redis boot-blip permanently degrades cluster rate limiting (S) · T4-F15 console.* bypasses redacting logger; PROCESS_ROLE default 'all' (S) · T1-F11 no prompt caching (M) · T1-F14 onboarding LLM prices unsanity-checked (S) · T2-F14 pre-greeting sequential lookups (M) · T2-F16 DTMF dead event / no keypad escape (S/L) · T3-F10 SW `/public/` guard (S) · T3-F13 FUNNEL.md drift (S) · T3-F14 BookingPage palette + labels (S) · T3-F15 view token in query string (S) · T6-F12 stale eval-results + telemetry on dead harness (S) · T6-F13 behaviors YAML consolidation (S).

---

## D — Refactoring Plans (plan-level only)

**REF-001 Versioned migrations.** Replace re-run-everything with a `schema_migrations` tracking table keyed on the existing `MIGRATIONS` ordered keys; per-migration transactions; out-of-band `CREATE INDEX CONCURRENTLY` lane; keep full-corpus mode for fresh DBs/testcontainers; make error 42710 fatal; add `migrate:status` drift reporting. Cost of not doing: deploys start failing deterministically as tables grow (T5-F01), swallowed rollbacks ship stale schemas (T5-F04), drift stays invisible (T5-F11). Effort L. Deps: none — do before data volume forces it.

**REF-002 Distributed voice session state.** Move `VoiceSessionStore` + CallSid index + locks + whisper cache to Redis (the store's own doc anticipates this); model Deepgram/ElevenLabs account concurrency; then lift `numReplicas=1`. Cost of not doing: hard capacity ceiling, single point of failure for all live calls (T2-F04). Effort XL. Deps: T2-F06 (working load harness) first — measure the single-replica ceiling before building for N.

**REF-003 Observability spine.** Thread one correlation ID request→queue envelope→worker child-logger→voice session (AsyncLocalStorage; seam exists at `queues/queue.ts:296`); Sentry in the global error handler + fatal handlers; `http_request_duration` histogram; route the 41 `console.*` through the redacting logger. Cost: prod incidents stay archaeology (T4-F03). Effort M.

**REF-004 One config truth.** Merge `configSchema` and `validateEnvSchema`; add every live secret (encryption keys, provider keys) to the schema + `.env.production.example`; boot-validate. Cost: first-use 500s instead of failed deploys (T4-F06). Effort S-M.

**REF-005 Claim-before-send messaging standard.** Promote the lifecycle-email claim/release ledger pattern to a shared helper; migrate the ~6 mark-after-send workers; drop reliance on the unverified Twilio header. Cost: duplicate customer SMS on every crash-window (T4-F01). Effort M.

**REF-006 LLM output contract layer.** One shared `parseLlmJson<T>(zodSchema)`; route every task handler through its proposal contract; stamp prompt content-hash into `ai_runs.metadata.promptVersionId` (plumbing exists); delete the vestigial prompt registry or back it properly. Cost: CLAUDE.md's "Zod-validated proposals" claim stays partially false; prompt regressions remain unattributable (T1-F05/F12). Effort M.

**REF-007 Estimates/Invoices page dedup.** Shared `<DocumentSendSheet>` + generic master/detail wrapper; `enabled: !selectedId` list gating. Cost: ~3k LOC of drifting clones, wasted fetch per deep-link (T3-F04). Effort M.

**REF-008 Corpus consolidation.** One canonical utterance schema (migrate the 3,034 legacy rows — richer slot labels — rather than delete), one behaviors file generated from `SUPPORTED_INTENTS`, manifest regenerated from data, vocab (`data/vocab`, 1,610 terms) wired into vertical-pack `sttKeywords`, Reddit pipeline: archive or wire (explicit decision). Cost: comprehension layer stays broken and its best assets stay inert (T6-F01/F03/F06/F07/F08). Effort L (composite).

**REF-009 Dead-code sweep.** Per CLAUDE.md mandate: `failover.ts`, `prompt_injection_detected`, `dtmf_received` (or wire as keypad escape), dormant onboarding orchestrator, clarification-generator, `db/client.ts`+`connection.ts`, `makePoliciesIdempotent`, `OperationStatus`/`PaymentRecordForm`/`ImageWithFallback`, `/design` route gating, radix chunk rule, `classify-urgency-tier` (or ship `corpus/` in the image), stale `/experiments` doc refs. Cost: every one is a mislead for the next engineer; several have green tests faking coverage. Effort S-M (mechanical, spread across areas).

---

## Prioritized Roadmap

**Now — restore truth, stop caller-facing harm (≈1–2 weeks of focused work)**
1. T2-F01 — pin `output_format=pcm_16000` + first-chunk sanity guard (default-format question already resolved: `mp3_44100`); confirm with one staging call / byte-probe using the Railway-held key. *A near-certain total-failure of the flagship realtime path; one-line fix.*
2. T2-F03 + T2-F05 — silence handling on both transports. *Callers are being hung up on / stranded today.*
3. T6-F02 → T6-F01 → T6-F03 — corpus CI gates, canonical schema, taxonomy re-sync. *Un-breaks the entire comprehension/eval layer and its trust.*
4. T1-F01 — cost-capped real-LLM smoke on the PR/deploy path. *Ends LLM-free green lights for prompt changes.*
5. T4-F02 + T4-F05 — rate-limit retune. *Self-inflicted outage at first multi-user office; lost Twilio callbacks.*
6. T4-F04, T4-F06, T3-F02, T4-F12(audit-catch) — small authz/config/storage hygiene with outsized blast radius. *All S effort.*
7. T4-F01 / REF-005 (first two workers) — close the duplicate-SMS window on the highest-volume senders.

**Next — scale hardening before any 1,000-session push (≈1 month)**
1. REF-001 versioned migrations (+T5-F04 fatal, T5-F11 status). *Must land before hot-table growth makes deploys fail; everything else that adds indexes depends on it.*
2. T5-F02 retention/partitioning + PII retention policy (feeds GAP-008). *Rows compound daily; later = a data-migration project.*
3. T5-F03/T4-F09 tx-hold exemptions + tx-hold-time metric. *Cheapest big capacity win.*
4. T2-F06 → capacity run → publish the real ceiling (feeds REF-002 sizing and the 1,000-session claim).
5. Latency wave: T2-F02 filler-at-final-transcript, T2-F11 endpointing/speculative classify, T2-F14 parallel pre-greeting (GAP-002). *Sequenced S/M items, measurable per step via `voice_turn_latency_ms`.*
6. T1-F02, T1-F03, T1-F04, T1-F10 — guardrail wave (customer protection intents, shared injection guard + real-model adversarial bucket, verifiable confidence, grader hygiene).
7. T6-F05 Spanish live gate; T4-F11 suppression list (GAP-005); REF-003 observability spine; T1-F07 second provider (GAP-007); T1-F08 quota UX; T3-F01 make one real-API web suite mandatory.

**Later — competitive build-out on the hardened base**
1. GAP-001 autonomous in-call booking as the default lane (after Now-wave silence/latency fixes make it demo-safe).
2. GAP-002 remainder: streamed first-sentence TTS; GAP-006 operator voice UX (wire assistant streaming T3-F07, mobile PTT, offline capture T3-F11).
3. GAP-003 Spanish customer money surfaces (T3-F03).
4. GAP-004 catalog-priced voice invoicing; then GAP-009 truck inventory / equipment / job profit (repo's own Phase-3 sequencing holds).
5. REF-002 Redis voice state → multi-replica (only after the measured ceiling demands it); REF-007 est/inv dedup; REF-008 corpus consolidation + vocab wiring; REF-006 output contracts; REF-009 dead-code sweep (fold into each area's first touch).
6. GAP-008 SOC 2 readiness track (org-level, seeded by the retention work); GAP-010 QuickBooks depth audit.

Deliberately **not** Now: anything XL (REF-002), feature gaps (B) ahead of the truth/safety fixes, and the Medium/Low hygiene tail — it rides along with area work.

---

## Confidence & Gaps Register

What this audit could not verify, what was assumed, and what closes each gap:

| # | Unverified | Assumed for this report | To close |
|---|---|---|---|
| 1 | ~~ElevenLabs stream-input default output format~~ **Resolved 2026-07-18**: `mp3_44100` default confirmed via ElevenLabs API reference + elevenlabs-python issue #251 → T2-F01 Confidence High | Bug near-certain when Media Streams active | Residual: is `voice_realtime` enabled anywhere? Final byte-probe/ear-check with the Railway-held key (probe recipe in doc 02) |
| 2 | Whether Deepgram accepts `?token=` WS auth (if not, all realtime silently pins to Gather) | It works (calls appear to function) | Staging logs: `deepgram_open_failed` frequency |
| 3 | GitHub Actions run history — weekly live gate red/green, Layer-2 ever run, `release/*` branches ever cut, voice-smoke secrets populated | Gates run as configured | CI run history access |
| 4 | Railway env values: `TWILIO_MEDIA_STREAMS_ENABLED`, `RLS_RUNTIME_ROLE`, `AI_CACHE_ENABLED`, `REDIS_URL`, per-tier models, `PROCESS_ROLE`, pool sizes | Code defaults + docs describe intent | Railway dashboard read access |
| 5 | Prod DB reality: row counts, table sizes, index usage, autovacuum, actual migration wall-time | Scale estimates derived from the 1,000-session design target | Read replica / `pg_stat` snapshot |
| 6 | Actual prod voice-turn latency (histogram exists, no dashboard access) | Code-constant-derived 1.5–2.9s estimates | Grafana/PostHog access to `voice_turn_latency_ms` |
| 7 | Whether Twilio `Messages.json` honors `Idempotency-Key` (load-bearing for T4-F01) | Unverified → treated as no protection | Empirical test or provider confirmation |
| 8 | Which tenants run `sourceTrustTier: 'autonomous'` (T1-F04 real-world exposure) | At least some do (feature is live-gated) | Prod data query |
| 9 | Live PostHog funnel emission (keys off-by-default) | Instrumentation dormant until keyed | PostHog project check |
| 10 | Web bundle sizes; qa-matrix suite green in provisioned CI; Clerk `serviceos` JWT template in live dashboard | Vite-comment claims; suites runnable | One provisioned CI run; Clerk dashboard |
| 11 | PgBouncer actually deployed in front of prod today | railway.toml says single-replica direct today, PgBouncer staged for scale-out | Railway service topology |
| 12 | QuickBooks sync depth/reliability (GAP-010) | D-013 "Built (manual trigger)" taken at face value | Focused follow-up audit |
| 13 | Whether prod PII reaches `serviceos_training` pre-scrub | Pipeline inert (0 rows), so no exposure today | Confirm the separate Supabase project is empty/absent |

**Method note:** six parallel read-only track audits over the working tree at `a9d06aa`; every finding cites file:line evidence; nothing was executed against live services; no application code, config, data, or infrastructure was modified. The only writes are the eight documents in `discovery/`.
