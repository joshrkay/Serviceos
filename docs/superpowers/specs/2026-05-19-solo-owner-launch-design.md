# Solo Owner-Operator Launch — Design

**Date:** 2026-05-19  
**Status:** Approved — implementation plan linked  
**Parent:** [ServiceOS Launch Readiness](./2026-05-14-serviceos-launch-readiness-design.md)  
**Related specs:** [§10 Onboarding](./2026-05-15-onboarding-self-serve-setup-design.md), [Sound Human Voice](./2026-05-16-sound-human-voice-design.md), [Voice Quality v1](./2026-05-03-voice-quality-v1-design.md)

---

## 1. Goal and non-goals

### Goal

Ship a **full public, self-serve launch** for a **solo HVAC or plumbing owner-operator**: sign up without human ops, complete setup, forward their business line, and trust the inbound AI agent on real customer calls. North-star metric: **time given back** (hours not spent on phone, texting, chasing, typing).

### Launch gating model (default — confirm with product)

| Layer | Decision | Rationale |
|-------|----------|-----------|
| **Signup** | **A — Fully open** | Matches launch-readiness spec: "full public launch, fully self-serve." |
| **App access** | **C — Soft product gate** | `ProtectedRoute` redirects to `/onboarding` until `GET /api/onboarding/status` reports `isComplete` (when `VITE_ONBOARDING_V2_ENABLED=true`). |
| **Inbound voice** | **Trial + subscription gates at webhook** | Per §10 spec: agent stops answering when subscription is not `trialing`/`active` or trial AI caps exceeded — independent of UI onboarding progress. |
| **Quality gate** | **Human + automated** | Layer 1 `launchGate.pass` plus runbook sign-off before marketing "AI answers your phone." |

**Open product question:** Should inbound calls be answered **before** onboarding step 6 (test call)? Today, Twilio may be provisioned at step 4 while the app shell still forces `/onboarding`. Default for this design: **yes** (number is live for forwarding instructions), but **trial caps** and **voice quality bar** limit blast radius. Alternative **B (waitlist)** is out of scope unless product overrides §1 signup row.

### Non-goals (launch surface)

- Multi-technician **dispatch board** (`/dispatch`) and supervisor sessions wall
- Crew assignment, route optimization, bilingual voice
- QuickBooks sync, marketing automation (`marketing_message` proposals)
- In-app assistant **read/query** intents (AST-05) and multi-step chaining (AST-07)
- Full Phase 18 voice/UI parity (26 actions)
- Layer 2 live-shadow voice corpus as a launch blocker
- Parts / inventory, full accounting, payroll

Underlying multi-tech data model may remain; **product surface** is owner-only.

---

## 2. Approach

**Chosen: "Phone first" sequencing (Approach A).**

1. Voice trust minimum (persisted `create_customer`, classifier, idempotency)  
2. Sound-human perceptual fixes + Layer 1 voice quality gate  
3. Enable onboarding v2 by default + harden E2E  
4. Launch ops (monitoring, rollback runbook, human sign-off)

**Rejected:**

- **Funnel first** — turns on onboarding before voice persistence; high churn at test-call and first real caller.  
- **Parallel cut date** — two workstreams integrate poorly at webhook + classifier + flags.

---

## 3. Success criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | New tenant reaches `isComplete` without human support | `GET /api/onboarding/status`; Playwright `e2e/journeys/onboarding-v2.spec.ts` (+ extended identity/pack steps) |
| 2 | Approved `create_customer` persists a DB row | Integration test on wired `CreateCustomerExecutionHandler`; no synthetic-only UUID |
| 3 | Inbound held-slot booking → inbox → approve → appointment exists | Existing held-slot + executor tests; manual pilot script |
| 4 | Layer 1 voice quality `launchGate.pass === true` | `packages/api/test/voice-quality/` corpus run; runbook §3 human sign-off |
| 5 | Agent turn TTFA within target after sound-human ship | VQ2-004 telemetry; dashboard or log aggregate |
| 6 | Trial abuse bounded | Webhook rejects over-cap / non-paying tenants; metrics counters |

---

## 4. Workstream A — Voice trust minimum

**Problem:** Stub execution handlers return `{ success: true, resultEntityId: uuidv4() }` without writes. Owners see approved proposals and empty CRM.

**Required for launch:**

| Item | Work | Reference |
|------|------|-----------|
| Persist `create_customer` | Wire handler to `customerRepo`; register real handler in registry | `production-readiness-blockers.md` Phase 1 |
| Classifier `create_customer` | Fix inbound intent for new signup utterances | **P18-001** |
| Idempotency | Pass `IdempotencyGuard` into `ProposalExecutor` | Production-readiness Phase 3 |
| Postgres repos in prod | `PgAssignmentRepository`, `PgDispatchAnalyticsRepository` when pool present | Production-readiness Phase 2 |
| Invoice delivery fail-fast | No silent `NoopInvoiceDeliveryProvider` in staging/prod | Production-readiness Phase 4 |

**Defer past launch (solo path still viable via UI):** `draft_estimate`, `create_job`, `update_customer` voice stubs — if web flows cover estimate/invoice loop.

**Inbound loop (minimum credible):**

```
Caller → STT → classify → create_customer (persist) → availability → held slot
       → CreateBooking proposal → owner inbox → approve → appointment + confirmation
```

---

## 5. Workstream B — Sound human + voice quality gate

### Sound human (in scope)

| ID | Feature | Purpose |
|----|---------|---------|
| F3 | ElevenLabs WebSocket streaming TTS | Cut 400–800ms buffered dead air per turn |
| P2-1 | Pre-synthesized filler engine (~250ms) | Cover LLM latency gap |
| P2-2 | Deepgram keyword boost from vertical packs | HVAC/plumbing jargon STT accuracy |

**Defer:** P2-3 repair templates (post-launch polish), in-app conversational barge-in.

### Voice quality Layer 1 (launch gate)

- Run full 40-script corpus per `voice-quality-launch-gate.md`
- **Floor criteria:** 100% per script (PII, tenancy, hangup, compliance, etc.)
- **Bucket `03-lead-capture`:** 100% — depends on P18-001 + persisted customer
- **Human sign-off** required even when `launchGate.pass === true`

Env prerequisites: `TWILIO_MEDIA_STREAMS_ENABLED`, production STT/TTS provider keys, `TTS_PROVIDER` soak plan documented.

---

## 6. Workstream C — Onboarding v2 go-live

**Current state:** Implementation largely complete; feature flag off.

| Action | Detail |
|--------|--------|
| Enable flag | `VITE_ONBOARDING_V2_ENABLED=true` in production web env |
| API flag | `ONBOARDING_V2_ENABLED` if used server-side for route behavior |
| Guard | `ProtectedRoute` + `useOnboardingStatus` — already implemented |
| E2E | Extend `e2e/journeys/onboarding-v2.spec.ts` for identity PUT + pack POST against migrated DB |
| Docs | Update deployment.md / `.env.example` |

**Derived status (no `onboarding_progress` table):** Six mandatory steps per §10 spec; step 6 = inbound `voice_sessions` ended **or** skip timestamp.

**Trial gates (already specced):** Subscription status + AI minute caps at inbound webhook; early-upgrade nudge after 30 minutes.

---

## 7. Workstream D — Solo-owner product surface

**Expose:** Home (time given back), approval inbox, schedule/calendar with held slots, customers, leads, estimates, invoices, money dashboard, settings (hours, buffer, phone forward).

**Do not add for launch:** `/dispatch` route or nav entry (dispatch board remains built but hidden per launch non-goals).

---

## 8. Verification and launch ops

### Pre-launch checklist

- [ ] `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] Onboarding integration tests green
- [ ] Production-readiness handler + idempotency tests green
- [ ] Voice quality Layer 1 `launchGate.pass`
- [ ] Runbook human sign-off (`docs/superpowers/runbooks/voice-quality-launch-gate.md`)
- [ ] Playwright onboarding v2 journey (with Clerk test creds)
- [ ] Rollback documented: disable inbound agent routing; set onboarding flag false if needed

### Rollback

1. Twilio: route inbound to previous handler or human CSR.  
2. Web: `VITE_ONBOARDING_V2_ENABLED=false` (restores legacy wizard, disables shell guard).  
3. Communicate pilot tenants if trial/subscription state affected.

---

## 9. Execution order

```text
T1  Production-readiness Phase 1–3 (create_customer, repos, idempotency)
T2  P18-001 classifier
T3  Sound-human F3 + P2-1 + P2-2
T4  Voice quality Layer 1 gate + human sign-off
T5  Onboarding v2 flag on + E2E hardening
T6  Public launch + monitoring
```

T5 may start E2E hardening in parallel after T2; do not enable public flag until T4 passes.

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Test call succeeds but CRM empty | T1 before T5 flag flip |
| Open signup + weak voice → bad reviews | T4 gate + pilot monitoring week |
| Onboarding E2E false confidence | Extend journey beyond render-only checks |
| Doc drift (May 14 audit "85%") | Treat codebase + this spec as source of truth |

---

## 11. Approval

- [x] Product confirms signup model (§1 table) — **A + C** (continued 2026-05-19)  
- [x] Engineering confirms T1–T6 order  
- [x] Voice lead confirms sound-human scope (F3, P2-1, P2-2 only for launch)

**Implementation plan:** [2026-05-19-solo-owner-launch.md](../plans/2026-05-19-solo-owner-launch.md)
