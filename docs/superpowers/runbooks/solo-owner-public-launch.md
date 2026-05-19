# Solo Owner — Public Launch Runbook

**Goal:** Cut over to **full public, self-serve launch** for a solo HVAC/plumbing owner-operator — onboarding v2 live, inbound voice trusted (persist + Layer 1 quality gate), sound-human pacing — without exposing dispatch/crew surfaces.

**Design spec:** [2026-05-19-solo-owner-launch-design.md](../specs/2026-05-19-solo-owner-launch-design.md)  
**Implementation plan:** [2026-05-19-solo-owner-launch.md](../plans/2026-05-19-solo-owner-launch.md)  
**Launch audit (PASS/FAIL tracker):** [2026-05-19-solo-owner-launch-audit.md](../plans/2026-05-19-solo-owner-launch-audit.md)  
**Voice quality gate (human sign-off):** [voice-quality-launch-gate.md](./voice-quality-launch-gate.md)

Do not enable marketing or open signup until every **Pre-launch checklist** item is checked in the audit doc.

---

## Pre-launch checklist

Copy from design spec §8 and implementation plan Phases 0–4. Record each result in the [audit doc](../plans/2026-05-19-solo-owner-launch-audit.md).

### Build and voice trust (Phase 0–1)

- [ ] **Production TypeScript build**

  ```bash
  cd packages/api && npx tsc --project tsconfig.build.json --noEmit
  ```

  Expected: exit 0.

- [ ] **Voice-trust unit tests** (`create_customer`, classifier, idempotency)

  ```bash
  cd packages/api && npx vitest run \
    test/proposals/execution/create-customer-handler.test.ts \
    test/ai/tasks/create-customer-task.test.ts \
    test/proposals/execution/executor.test.ts \
    test/proposals/execution-idempotency.test.ts \
    test/proposals/executor-onexecuted.test.ts
  ```

  Expected: all PASS.

- [ ] **app.ts production wiring** (manual grep)

  ```bash
  rg "CreateCustomerVoiceExecutionHandler|proposalIdempotencyGuard|PgAssignmentRepository" packages/api/src/app.ts
  ```

  Expected: all three present.

- [ ] **Invoice delivery fail-fast** (prod/staging boot)

  ```bash
  cd packages/api && npx vitest run test/proposals/execution/invoice-delivery-boot.test.ts
  ```

  Expected: PASS — `resolveInvoiceDeliveryProvider` throws when `SendService` is missing in production/staging.

- [ ] **Lead-capture corpus bucket** (comment + unit test)

  ```bash
  cd packages/api && npx vitest run test/voice-quality/corpus/03-lead-capture.test.ts
  ```

  Expected: PASS. Cassettes must be recorded (Phase 2) before expecting `launchGate.pass`.

### Voice quality Layer 1 (Phase 2)

- [ ] **Cassettes recorded** for scripts with empty `entries` (see [voice-quality-cassette-refresh.md](./voice-quality-cassette-refresh.md))

  ```bash
  cd packages/api && npm run voice-quality:record -- \
    --testNamePattern="create-customer-new-signup"
  ```

  Repeat for remaining empty cassettes. Requires `OPENAI_API_KEY` and voice-quality env per `packages/api/fixtures/ai/README.md`.

- [ ] **Layer 1 corpus — `launchGate.pass`**

  ```bash
  cd packages/api && npm run voice-quality
  ```

  Or equivalently:

  ```bash
  cd packages/api && npx vitest run -c vitest.voice-quality.config.ts
  ```

  Expected: `launchGate.pass === true` in output or `voice-quality-report.json` artifact.

- [ ] **Human sign-off** per [voice-quality-launch-gate.md](./voice-quality-launch-gate.md) §3 — record approver + date in the [audit doc](../plans/2026-05-19-solo-owner-launch-audit.md).

### Sound human + API env (Phase 3)

- [ ] **Sound-human test suite**

  ```bash
  cd packages/api && npx vitest run \
    test/ai/tts/elevenlabs-stream.test.ts \
    test/ai/agents/customer-calling/filler-engine.test.ts \
    test/voice/vertical-terminology-provider.test.ts \
    test/telephony/media-streams/mediastream-adapter.test.ts
  ```

  Expected: all PASS.

- [ ] **Railway API env** — voice vars set per [deployment.md](../../deployment.md) § Solo owner launch (voice):

  | Variable | Value |
  |----------|-------|
  | `TWILIO_MEDIA_STREAMS_ENABLED` | `true` |
  | `TTS_PROVIDER` | `elevenlabs` (after soak) |
  | `ELEVENLABS_API_KEY` | set |
  | `DEEPGRAM_API_KEY` | set |
  | `DATABASE_URL` | set (no in-memory proposals in prod) |

- [ ] **TTFA spot-check** — one staging test call; confirm `audio_frame_emitted` TTFA p50 &lt; 800ms in logs. Record in audit doc.

### Onboarding v2 (Phase 4)

- [ ] **Onboarding integration tests**

  ```bash
  cd packages/api && npx vitest run test/integration/onboarding-status.test.ts
  ```

  Expected: PASS (may run in integration CI only).

- [ ] **Trial gates on inbound webhook**

  ```bash
  cd packages/api && npx vitest run test/voice/voice-gate.test.ts packages/api/src/voice/trial-limits.test.ts
  ```

  Manual: inbound call on expired-trial tenant → TwiML reject / cap message per spec.

- [ ] **Playwright onboarding v2 journey** (Clerk test creds)

  ```bash
  export VITE_ONBOARDING_V2_ENABLED=true
  export E2E_CLERK_PUBLISHABLE_KEY=pk_test_...
  export E2E_CLERK_SECRET_KEY=sk_test_...
  npx playwright test e2e/journeys/onboarding-v2.spec.ts
  ```

  Expected: PASS.

- [ ] **Rollback documented** — see [Rollback](#rollback) below; confirm runbook linked from launch ticket.

---

## Go-live steps

Execute in order after the pre-launch checklist is complete in the audit doc.

### 1. API — voice environment (Railway)

Set on the **API** service (see [deployment.md](../../deployment.md)):

| Variable | Value |
|----------|-------|
| `TWILIO_MEDIA_STREAMS_ENABLED` | `true` |
| `TTS_PROVIDER` | `elevenlabs` |
| `ELEVENLABS_API_KEY` | *(secret)* |
| `DEEPGRAM_API_KEY` | *(secret)* |
| `DATABASE_URL` | *(linked Postgres)* |
| Twilio / SendGrid comms | configured so `SendService` is live (invoice delivery fail-fast) |

Redeploy API after env change. Confirm `/ready` healthy.

### 2. Web — onboarding v2 (Railway build-time)

On the **web** service, set **build** variable:

```bash
VITE_ONBOARDING_V2_ENABLED=true
```

Rebuild/redeploy web so the flag is baked into the Vite bundle. Optional server flag if used: `ONBOARDING_V2_ENABLED=true`.

### 3. Voice quality launch gate (final)

```bash
cd packages/api && npm run voice-quality
```

- Confirm `launchGate.pass === true`.
- Complete [voice-quality-launch-gate.md](./voice-quality-launch-gate.md) §3 human sign-off; update [audit doc](../plans/2026-05-19-solo-owner-launch-audit.md) Human sign-off table.

### 4. Smoke and monitor

```bash
API_BASE_URL=https://api.<env>.serviceos.com bash scripts/smoke.sh
```

- Watch error rate, voice session metrics, trial-cap rejections for 24h.
- Do not announce public launch until Step 3 sign-off is recorded.

---

## Rollback

If inbound quality, onboarding, or billing regressions appear post-cutover:

### 1. Twilio — stop agent-first routing

Route inbound DID(s) to the **previous handler** (human CSR, voicemail, or legacy TwiML). This is the fastest blast-radius limiter for bad caller experience.

Document which Twilio Studio flow / webhook URL was restored.

### 2. Web — disable onboarding v2

Set on the web service (build-time):

```bash
VITE_ONBOARDING_V2_ENABLED=false
```

Redeploy web. Effect:

- Restores legacy 9-step onboarding wizard.
- Disables `ProtectedRoute` shell guard tied to `GET /api/onboarding/status`.

API trial/subscription gates at the inbound webhook **remain active** unless separately changed.

### 3. Pilot / early tenants

If trial or subscription state was changed during cutover:

- Email or call affected pilot tenants with status and ETA.
- Note changes in support CRM / launch ticket.

### 4. Post-rollback verification

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Confirm inbound test call hits the rollback handler (not Media Streams agent) before closing the incident.

---

## Related documents

| Document | Purpose |
|----------|---------|
| [voice-quality-launch-gate.md](./voice-quality-launch-gate.md) | Layer 1 thresholds, nightly green runs, human sign-off §3 |
| [2026-05-19-solo-owner-launch-audit.md](../plans/2026-05-19-solo-owner-launch-audit.md) | PASS/FAIL tracker and sign-off table |
| [voice-quality-cassette-refresh.md](./voice-quality-cassette-refresh.md) | Cassette record/refresh when corpus fails |
| [deployment.md](../../deployment.md) | Railway migration policy + solo voice env table |
