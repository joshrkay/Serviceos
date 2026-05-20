# Solo Owner-Operator Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship full public self-serve launch for a solo HVAC/plumbing owner-operator — onboarding v2 live, inbound voice trusted (persist + quality gate), perceptually human pacing — without exposing dispatch/crew surfaces.

**Architecture:** Phone-first sequencing per [design spec](../specs/2026-05-19-solo-owner-launch-design.md). Most foundation work is **already merged** (`CreateCustomerVoiceExecutionHandler`, `IdempotencyGuard`, `PgAssignmentRepository`, P18-001 regex classifier, `FillerEngine`, ElevenLabs `synthesizeStream`). This plan focuses on **verification, corpus recording, env go-live, and gaps**.

**Tech Stack:** TypeScript, Express API, React/Vite web, Vitest, Playwright, Twilio Media Streams, Deepgram, ElevenLabs WS TTS, Stripe, Clerk.

**Spec:** [2026-05-19-solo-owner-launch-design.md](../specs/2026-05-19-solo-owner-launch-design.md)

**Child plans (reference only — do not duplicate):**
- [2026-04-23-production-readiness-blockers.md](./2026-04-23-production-readiness-blockers.md) — Phases 1–3 largely done; Phase 4 delivery fail-fast may remain
- [2026-05-16-sound-human-voice.md](./2026-05-16-sound-human-voice.md) — F3/P2-1/P2-2 largely implemented; verify + soak
- [2026-05-15-onboarding-self-serve-setup.md](./2026-05-15-onboarding-self-serve-setup.md) — implementation done; flag + E2E remain

---

## File structure (this plan touches)

| Path | Responsibility |
|------|----------------|
| `packages/api/src/proposals/execution/handlers.ts` | Stub handlers (`draft_estimate`, etc.) — verify only |
| `packages/api/src/app.ts` | Invoice delivery provider selection; voice deps wiring |
| `packages/api/src/ai/voice-quality/corpus/cassettes/*.json` | Record real LLM exchanges for Layer 1 gate |
| `packages/api/test/voice-quality/` | Corpus runner + launch gate assertions |
| `packages/web/.env.production` / Railway vars | `VITE_ONBOARDING_V2_ENABLED=true` |
| `e2e/journeys/onboarding-v2.spec.ts` | Extend identity + pack steps |
| `docs/deployment.md` | Document launch env vars + rollback |
| `.env.example` | Default onboarding flag + voice provider notes |

---

## Phase 0 — Baseline audit (do first)

### Task 0.1: Confirm merged foundations

**Files:** Read-only audit

- [ ] **Step 1: Verify production build**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: exit 0.

- [ ] **Step 2: Run voice-trust unit tests**

```bash
cd packages/api && npx vitest run \
  test/proposals/execution/create-customer-handler.test.ts \
  test/ai/tasks/create-customer-task.test.ts \
  test/proposals/execution/executor.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Confirm app.ts wiring (manual grep)**

```bash
rg "CreateCustomerVoiceExecutionHandler|proposalIdempotencyGuard|PgAssignmentRepository" packages/api/src/app.ts
```

Expected: all three present (already at ~878, ~1307–1326).

- [ ] **Step 4: Record audit notes**

Create `docs/superpowers/plans/2026-05-19-solo-owner-launch-audit.md` with PASS/FAIL per row:

| Check | Command / file | Status |
|-------|----------------|--------|
| create_customer persists | `create-customer-handler.test.ts` | |
| P18-001 classifier | `create-customer-task.test.ts` AST-01 block | |
| Idempotency wired | `executor.test.ts` duplicate key test | |
| Sound-human streaming | `rg synthesizeStream mediastream-adapter.ts` | |
| Filler engine | `rg runTurnWithFiller mediastream-adapter.ts` | |
| Onboarding status API | `test/integration/onboarding-status.test.ts` | |

- [ ] **Step 5: Commit audit doc**

```bash
git add docs/superpowers/plans/2026-05-19-solo-owner-launch-audit.md
git commit -m "docs: solo launch baseline audit checklist"
```

---

## Phase 1 — Voice trust verification & prod delivery

### Task 1.1: Fix stale corpus test commentary

**Files:**
- Modify: `packages/api/test/voice-quality/corpus/03-lead-capture.test.ts:14-18`

- [ ] **Step 1: Update comment**

Replace the block that says failure is "pre-P17-001" with:

```typescript
// create-customer-new-signup: bucket-03 script; disposition grading
// depends on P18-001 classifier + persisted create_customer execution.
// Cassettes must be recorded (Phase 2) before expecting launchGate pass.
```

- [ ] **Step 2: Run test**

```bash
cd packages/api && npx vitest run test/voice-quality/corpus/03-lead-capture.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -am "test(voice-quality): fix stale P17-001 comment on lead-capture bucket"
```

### Task 1.2: Production invoice delivery fail-fast (if audit shows Noop in staging/prod)

**Files:**
- Modify: `packages/api/src/app.ts` (~1229–1231)
- Modify: `packages/api/src/proposals/execution/voice-extended-handlers.ts`
- Test: `packages/api/test/proposals/execution/invoice-delivery-boot.test.ts` (create)

**Context:** Today `invoiceDeliveryProvider` uses `NoopInvoiceDeliveryProvider` when `sendService` is unset. Solo launch needs prod/staging to **fail at boot** if delivery cannot send.

- [ ] **Step 1: Write failing boot test**

```typescript
// packages/api/test/proposals/execution/invoice-delivery-boot.test.ts
import { describe, it, expect } from 'vitest';
import { resolveInvoiceDeliveryProvider } from '../../../src/proposals/execution/invoice-delivery-factory';

describe('invoice delivery provider', () => {
  it('throws in production when SendService is not configured', () => {
    expect(() =>
      resolveInvoiceDeliveryProvider({
        nodeEnv: 'production',
        sendService: undefined,
      }),
    ).toThrow(/SendService|delivery/i);
  });

  it('returns noop in test env when SendService is not configured', () => {
    const provider = resolveInvoiceDeliveryProvider({
      nodeEnv: 'test',
      sendService: undefined,
    });
    expect(provider.constructor.name).toContain('Noop');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (factory may not exist yet)

```bash
cd packages/api && npx vitest run test/proposals/execution/invoice-delivery-boot.test.ts
```

- [ ] **Step 3: Extract factory from app.ts**

```typescript
// packages/api/src/proposals/execution/invoice-delivery-factory.ts
import type { SendService } from '../../comms/send-service';
import {
  NoopInvoiceDeliveryProvider,
  SendServiceInvoiceDeliveryProvider,
} from './voice-extended-handlers';

export function resolveInvoiceDeliveryProvider(opts: {
  nodeEnv: string;
  sendService: SendService | undefined;
}) {
  if (opts.sendService) {
    return new SendServiceInvoiceDeliveryProvider(opts.sendService);
  }
  if (opts.nodeEnv === 'production' || opts.nodeEnv === 'staging') {
    throw new Error(
      'Invoice delivery requires SendService in production/staging. Configure Twilio/SendGrid credentials.',
    );
  }
  return new NoopInvoiceDeliveryProvider();
}
```

- [ ] **Step 4: Use factory in app.ts**

Replace inline ternary at ~1229 with:

```typescript
const invoiceDeliveryProvider = resolveInvoiceDeliveryProvider({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  sendService,
});
```

- [ ] **Step 5: Run tests + production tsc**

```bash
cd packages/api && npx vitest run test/proposals/execution/invoice-delivery-boot.test.ts
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proposals/execution/invoice-delivery-factory.ts \
  packages/api/src/app.ts \
  packages/api/test/proposals/execution/invoice-delivery-boot.test.ts
git commit -m "fix(api): fail fast when invoice delivery missing in prod/staging"
```

**Skip Task 1.2** if staging/prod already has `sendService` wired and product accepts noop only in `development`.

---

## Phase 2 — Voice quality Layer 1 launch gate

### Task 2.1: Record cassettes for bucket 03 (lead capture)

**Files:**
- Modify: `packages/api/src/ai/voice-quality/corpus/cassettes/create-customer-new-signup.json` (and siblings with empty `entries`)

- [ ] **Step 1: Run record mode for one script**

```bash
cd packages/api && npm run voice-quality:record -- \
  --testNamePattern="create-customer-new-signup"
```

Requires: `OPENAI_API_KEY`, voice-quality env documented in `fixtures/ai/README.md`. Re-run until cassette `entries` is non-empty.

- [ ] **Step 2: Commit cassette**

```bash
git add packages/api/src/ai/voice-quality/corpus/cassettes/create-customer-new-signup.json
git commit -m "test(voice-quality): record cassette for create-customer-new-signup"
```

- [ ] **Step 3: Repeat for remaining scripts with empty cassettes**

Run full record pass per [voice-quality-cassette-refresh.md](../runbooks/voice-quality-cassette-refresh.md).

### Task 2.2: Run Layer 1 corpus and capture launch gate report

**Files:** None (operational)

- [ ] **Step 1: Run corpus**

```bash
cd packages/api && npx vitest run -c vitest.voice-quality.config.ts
```

Expected: `launchGate.pass === true` in output or report artifact.

- [ ] **Step 2: If FAIL — triage by bucket**

| Bucket | Typical fix |
|--------|-------------|
| `03-lead-capture` | Classifier regex + golden disposition |
| `10-adversarial` | Floor criteria — must not auto-mutate / leak PII |
| `09-concurrency` | Document known v1 waivers per runbook |

- [ ] **Step 3: Human sign-off**

Follow [voice-quality-launch-gate.md](../runbooks/voice-quality-launch-gate.md) §3. Record approver + date in audit doc.

- [ ] **Step 4: Commit any golden/cassette fixes**

One commit per bucket fixed.

---

## Phase 3 — Sound-human verification & production env

**Reference:** [2026-05-16-sound-human-voice.md](./2026-05-16-sound-human-voice.md) for deep implementation. This phase is **verify + configure**.

### Task 3.1: Run sound-human test suite

- [ ] **Step 1:**

```bash
cd packages/api && npx vitest run \
  test/ai/tts/elevenlabs-stream.test.ts \
  test/ai/agents/customer-calling/filler-engine.test.ts \
  test/voice/vertical-terminology-provider.test.ts \
  test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: PASS. If FAIL, fix using child plan tasks (do not invent parallel implementations).

### Task 3.2: Production env checklist

**Files:**
- Modify: `docs/deployment.md` (append § Solo owner launch env)
- Modify: `.env.example`

- [ ] **Step 1: Document required production vars**

```markdown
## Solo owner launch (voice)

| Variable | Purpose |
|----------|---------|
| `TWILIO_MEDIA_STREAMS_ENABLED=true` | Media Streams path |
| `TTS_PROVIDER=elevenlabs` | Streaming TTS (after soak) |
| `ELEVENLABS_API_KEY` | TTS |
| `DEEPGRAM_API_KEY` | STT + keyword boost |
| `DATABASE_URL` | Required — no in-memory proposals in prod |
```

- [ ] **Step 2: Set vars in Railway** (manual — document in audit doc when done)

- [ ] **Step 3: Commit docs**

```bash
git add docs/deployment.md .env.example
git commit -m "docs: solo launch voice env checklist"
```

### Task 3.3: TTFA spot-check

- [ ] **Step 1:** Place one test call in staging; confirm `audio_frame_emitted` events show TTFA &lt; 800ms p50 in logs.

- [ ] **Step 2:** Record result in audit doc (no code unless regression found).

---

## Phase 4 — Onboarding v2 go-live

### Task 4.1: Enable feature flag defaults

**Files:**
- Modify: `.env.example`
- Modify: `packages/web/.env.example` (if present)

- [ ] **Step 1: Change default in `.env.example`**

```bash
VITE_ONBOARDING_V2_ENABLED=true
```

Add comment: "Set false only for legacy wizard rollback."

- [ ] **Step 2: Set Railway/Vercel production web service**

`VITE_ONBOARDING_V2_ENABLED=true` at build time.

- [ ] **Step 3: Commit example only** (prod vars are operational, not in git)

```bash
git commit -am "chore: default onboarding v2 enabled in env example"
```

### Task 4.2: Extend Playwright onboarding journey

**Files:**
- Modify: `e2e/journeys/onboarding-v2.spec.ts`

- [ ] **Step 1: Add identity form submit test**

After filling business name + hours, click Save and assert sidebar shows step 3 current (pack). Use API mock or real backend with migrated DB per journey comment block.

- [ ] **Step 2: Add pack selection test**

Click HVAC card → assert `POST /api/onboarding/pack` success (intercept or UI ✓ on card).

- [ ] **Step 3: Run locally**

```bash
export VITE_ONBOARDING_V2_ENABLED=true
export E2E_CLERK_PUBLISHABLE_KEY=pk_test_...
export E2E_CLERK_SECRET_KEY=sk_test_...
npx playwright test e2e/journeys/onboarding-v2.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/journeys/onboarding-v2.spec.ts
git commit -m "test(e2e): extend onboarding v2 identity and pack steps"
```

### Task 4.3: Verify trial gates on inbound webhook

**Files:**
- Test: `packages/api/test/voice/voice-gate.test.ts` (run existing)

- [ ] **Step 1:**

```bash
cd packages/api && npx vitest run test/voice/voice-gate.test.ts packages/api/src/voice/trial-limits.test.ts
```

- [ ] **Step 2: Manual — call inbound with expired trial tenant; expect TwiML reject / message per spec**

---

## Phase 5 — Launch ops & spec closure

### Task 5.1: Update design spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-05-19-solo-owner-launch-design.md`

- [ ] **Step 1:** Set `Status: Approved` and check §11 boxes for signup model **A + C** (confirmed by product continue).

- [ ] **Step 2:** Link this plan in §11 footer.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-19-solo-owner-launch-design.md
git commit -m "docs: approve solo owner launch spec and link implementation plan"
```

### Task 5.2: Launch runbook snippet

**Files:**
- Create: `docs/superpowers/runbooks/solo-owner-public-launch.md`

- [ ] **Step 1: Write rollback + go-live checklist** (copy §8 from design spec + Phase 0–4 commands).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/solo-owner-public-launch.md
git commit -m "docs: solo owner public launch runbook"
```

### Task 5.3: Final pre-launch gate

- [ ] Run full checklist from design spec §8 — all boxes checked in audit doc.
- [ ] PR to `main` with audit doc + any code fixes from Phases 1–4.

---

## Deferred (explicit — not in this plan)

| Item | Why deferred |
|------|----------------|
| `/dispatch` route | Launch non-goal for solo surface |
| `draft_estimate` / `create_job` voice stubs | Web paths cover money loop |
| AST-05 query intents | Post-launch office chat parity |
| INV-03 auto-delivery on issue | Follow-up plan; not blocking phone-first |
| QuickBooks P7 | Post-launch |
| Layer 2 voice corpus | Not a launch blocker per design |

---

## Plan self-review (completed)

| Spec requirement | Task |
|------------------|------|
| Voice trust minimum | Phase 0–1 (verify + delivery fail-fast) |
| P18-001 / lead capture | Phase 2 cassettes + corpus |
| Sound human F3/P2-1/P2-2 | Phase 3 verify + env |
| Onboarding v2 go-live | Phase 4 |
| Launch ops / rollback | Phase 5 |
| Non-goals respected | Deferred table |

No TBD placeholders in task steps above.
