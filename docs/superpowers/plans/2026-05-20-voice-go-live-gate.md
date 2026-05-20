# Voice Go-Live Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit owner-controlled go-live gate (`voice_agent_live_at`) between subscription billing (Gate A) and trial caps (Gate B) so inbound AI only answers after go-live or a completed AI test call.

**Architecture:** Reuse existing `createVoiceGate`, `onSessionEnded` → `checkAndFireUpgradeNudge`, and onboarding v2 derived status. Add migration `106_*`, helpers in `voice/go-live.ts`, extend gate + telephony TwiML, mount `POST /api/voice/go-live|pause` on existing `createVoiceRouter`, expose `voiceAgentLive` on onboarding status, fix TestCallStep copy.

**Tech Stack:** TypeScript, Express, Postgres (`pg.Pool`), Zod, Vitest, React 18, Vite.

**Spec:** [`docs/superpowers/specs/2026-05-20-voice-go-live-gate-design.md`](../specs/2026-05-20-voice-go-live-gate-design.md)

**Do not rebuild:** Gate A+B (`voice-gate.ts`), onboarding v2 UI, migration 098, skip API, outbound allowlist (`outbound-allowlist.ts`).

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `packages/api/src/db/migrations/106_tenant_settings_voice_agent_live.sql` | Create | Add column |
| `packages/api/src/db/schema.ts` | Modify | Register `106_*` in `MIGRATIONS` |
| `packages/api/test/db/migration-106.test.ts` | Create | Migration smoke |
| `packages/api/test/db/migration-immutability.test.ts` | Modify | Hash for `106_*` after SQL frozen |
| `packages/api/src/voice/go-live.ts` | Create | enable / pause / auto / load live_at |
| `packages/api/test/voice/go-live.test.ts` | Create | Helper unit tests |
| `packages/api/src/voice/voice-gate.ts` | Modify | Go-live gate + `not_live` |
| `packages/api/src/voice/trial-limits.ts` | Modify | Add `not_live` to `GateReason` |
| `packages/api/test/voice/voice-gate.test.ts` | Modify | Mock `tenant_settings` query |
| `packages/api/src/routes/voice.ts` | Modify | `POST /go-live`, `POST /pause` |
| `packages/api/test/routes/voice-go-live.test.ts` | Create | Route integration |
| `packages/api/src/routes/telephony.ts` | Modify | Reason-specific TwiML + fail-closed |
| `packages/api/test/telephony/telephony-voice-gate.test.ts` | Modify | `not_live` copy + fail-closed |
| `packages/api/src/telephony/twilio-adapter.ts` | Modify | Pass `channel` in `onSessionEnded` |
| `packages/api/src/app.ts` | Modify | Auto go-live in `onSessionEnded` |
| `packages/api/src/onboarding/load-facts.ts` | Modify | Load `voice_agent_live_at` |
| `packages/api/src/onboarding/contracts.ts` | Modify | `voiceAgentLive` on response |
| `packages/api/test/onboarding/derive-status.test.ts` | Modify | `voiceAgentLive` field |
| `packages/api/test/integration/onboarding-status.test.ts` | Modify | DB column reflected |
| `packages/api/test/integration/voice-go-live-auto.test.ts` | Create | Auto + skip |
| `packages/web/src/types/onboarding.ts` | Modify | `voiceAgentLive` |
| `packages/web/src/components/onboarding/v2/steps/TestCallStep.tsx` | Modify | Copy + go-live button |
| `packages/web/src/components/onboarding/v2/steps/PhoneStep.tsx` | Modify | Helper line |
| `packages/web/src/components/settings/SettingsPage.tsx` | Modify | AI answering toggle |

> **Migration number:** Spec says `100_*` but `100_payments_refund_tracking` already exists in `schema.ts`. Use **`106_tenant_settings_voice_agent_live`**.

---

## Phase 1 — Schema

### Task 1: Migration 106

**Files:**
- Create: `packages/api/src/db/migrations/106_tenant_settings_voice_agent_live.sql`
- Modify: `packages/api/src/db/schema.ts` (append `MIGRATIONS` entry after `105_*`)
- Create: `packages/api/test/db/migration-106.test.ts`

- [ ] **Step 1: Write migration file**

```sql
-- 106_tenant_settings_voice_agent_live.sql
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS voice_agent_live_at TIMESTAMPTZ;
```

- [ ] **Step 2: Register in schema.ts**

```ts
  '106_tenant_settings_voice_agent_live': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS voice_agent_live_at TIMESTAMPTZ;
  `,
```

- [ ] **Step 3: Write migration test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 106 — voice_agent_live_at', () => {
  it('is registered in MIGRATIONS', () => {
    expect(MIGRATIONS['106_tenant_settings_voice_agent_live']).toMatch(
      /voice_agent_live_at\s+TIMESTAMPTZ/,
    );
  });
  it('matches on-disk SQL', () => {
    const sql = readFileSync(
      join(__dirname, '../../src/db/migrations/106_tenant_settings_voice_agent_live.sql'),
      'utf8',
    );
    expect(sql).toMatch(/voice_agent_live_at/);
  });
});
```

- [ ] **Step 4: Run test**

```bash
cd packages/api && npx vitest run test/db/migration-106.test.ts
```

Expected: PASS

- [ ] **Step 5: Update migration immutability hash**

Run after SQL is final:

```bash
cd packages/api && node -e "const fs=require('fs');const c=require('crypto');const s=fs.readFileSync('src/db/migrations/106_tenant_settings_voice_agent_live.sql','utf8');console.log(c.createHash('sha256').update(s).digest('hex'));"
```

Add `['106_tenant_settings_voice_agent_live', '<hash>']` to `packages/api/test/db/migration-immutability.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/db/migrations/106_tenant_settings_voice_agent_live.sql \
  packages/api/src/db/schema.ts packages/api/test/db/migration-106.test.ts \
  packages/api/test/db/migration-immutability.test.ts
git commit -m "feat(db): add tenant_settings.voice_agent_live_at (migration 106)"
```

---

## Phase 2 — Go-live helpers

### Task 2: `go-live.ts` core

**Files:**
- Create: `packages/api/src/voice/go-live.ts`
- Create: `packages/api/test/voice/go-live.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import {
  loadVoiceAgentLiveAt,
  enableVoiceAgentLive,
  pauseVoiceAgentLive,
} from '../../src/voice/go-live';

function mockPool(rows: Record<string, unknown>[]): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
}

describe('go-live helpers', () => {
  it('loadVoiceAgentLiveAt returns null when unset', async () => {
    const pool = mockPool([{ voice_agent_live_at: null }]);
    expect(await loadVoiceAgentLiveAt(pool, 't1')).toBeNull();
  });

  it('enableVoiceAgentLive is idempotent (COALESCE)', async () => {
    const pool = mockPool([]);
    const audit = { create: vi.fn() };
    await enableVoiceAgentLive(
      { pool, auditRepo: audit as never },
      { tenantId: 't1', actorId: 'u1', source: 'manual' },
    );
    expect(pool.query).toHaveBeenCalled();
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/COALESCE\(voice_agent_live_at/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd packages/api && npx vitest run test/voice/go-live.test.ts
```

- [ ] **Step 3: Implement `go-live.ts`**

```ts
import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';

export type GoLiveSource = 'manual' | 'auto_test_call';

export async function loadVoiceAgentLiveAt(pool: Pool, tenantId: string): Promise<Date | null> {
  const res = await pool.query<{ voice_agent_live_at: Date | null }>(
    `SELECT voice_agent_live_at FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return res.rows[0]?.voice_agent_live_at ?? null;
}

export async function subscriptionAllowsVoice(
  pool: Pool,
  tenantId: string,
): Promise<boolean> {
  const res = await pool.query<{ subscription_status: string | null }>(
    `SELECT subscription_status FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const s = res.rows[0]?.subscription_status;
  return s === 'trialing' || s === 'active';
}

export async function enableVoiceAgentLive(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; actorId: string; source: GoLiveSource },
): Promise<{ voiceAgentLive: boolean; voiceAgentLiveAt: string | null }> {
  await deps.pool.query(
    `UPDATE tenant_settings
        SET voice_agent_live_at = COALESCE(voice_agent_live_at, NOW()), updated_at = NOW()
      WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const liveAt = await loadVoiceAgentLiveAt(deps.pool, input.tenantId);
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.source === 'manual' ? 'owner' : 'system',
      eventType: 'tenant.voice_agent_live',
      entityType: 'tenant_settings',
      entityId: input.tenantId,
      metadata: { source: input.source },
    }),
  );
  return {
    voiceAgentLive: liveAt != null,
    voiceAgentLiveAt: liveAt?.toISOString() ?? null,
  };
}

export async function pauseVoiceAgentLive(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; actorId: string },
): Promise<{ voiceAgentLive: false }> {
  await deps.pool.query(
    `UPDATE tenant_settings SET voice_agent_live_at = NULL, updated_at = NOW() WHERE tenant_id = $1`,
    [input.tenantId],
  );
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: 'owner',
      eventType: 'tenant.voice_agent_paused',
      entityType: 'tenant_settings',
      entityId: input.tenantId,
      metadata: {},
    }),
  );
  return { voiceAgentLive: false };
}

export async function maybeAutoGoLiveOnInboundEnd(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; channel: string },
): Promise<void> {
  if (input.channel !== 'voice_inbound') return;
  if (!(await subscriptionAllowsVoice(deps.pool, input.tenantId))) return;
  if (await loadVoiceAgentLiveAt(deps.pool, input.tenantId)) return;
  await enableVoiceAgentLive(deps, {
    tenantId: input.tenantId,
    actorId: 'system',
    source: 'auto_test_call',
  });
}
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): voice go-live enable/pause helpers"
```

---

## Phase 3 — Voice gate (`not_live`)

### Task 3: Extend `createVoiceGate`

**Files:**
- Modify: `packages/api/src/voice/trial-limits.ts` — add `'not_live'` to `GateReason`
- Modify: `packages/api/src/voice/voice-gate.ts`
- Modify: `packages/api/test/voice/voice-gate.test.ts`

- [ ] **Step 1: Add failing test**

```ts
  it('blocks with not_live when trialing but voice_agent_live_at is null', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM tenants')) {
          return { rows: [{ subscription_status: 'trialing' }] };
        }
        if (sql.includes('voice_agent_live_at')) {
          return { rows: [{ voice_agent_live_at: null }] };
        }
        return { rows: [{ daily_minutes: 0, total_minutes: 0, concurrent: 0 }] };
      }),
    } as unknown as Pool;
    const gate = createVoiceGate({ pool, auditRepo });
    const r = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(r).toEqual({ allowed: false, reason: 'not_live' });
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice_blocked_not_live' }),
    );
  });
```

- [ ] **Step 2: Implement in `voice-gate.ts`**

After Gate A passes, query `voice_agent_live_at` (reuse `loadVoiceAgentLiveAt` or inline). If null → audit `voice_blocked_not_live`, `voiceBlocksTotal.inc({ reason: 'not_live' })`, return `{ allowed: false, reason: 'not_live' }`.

- [ ] **Step 3: Run**

```bash
cd packages/api && npx vitest run test/voice/voice-gate.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): add go-live gate (not_live) to createVoiceGate"
```

---

## Phase 4 — HTTP routes

### Task 4: `POST /api/voice/go-live` and `/pause`

**Files:**
- Modify: `packages/api/src/routes/voice.ts` — add routes; extend factory deps with `pool`, `auditRepo` if missing
- Modify: `packages/api/src/app.ts` — pass `pool` into `createVoiceRouter` when present
- Create: `packages/api/test/routes/voice-go-live.test.ts`

- [ ] **Step 1: Extend `createVoiceRouter` signature**

```ts
export function createVoiceRouter(
  voiceRepo: VoiceRepository,
  queue: Queue,
  transcribeAudio?: TranscribeAudioFn,
  auditRepo?: AuditRepository,
  logger?: Logger,
  opts?: { pool?: Pool },
): Router
```

- [ ] **Step 2: Add routes (owner, requireTenant)**

```ts
router.post('/go-live', requireAuth, requireTenant, async (req, res) => {
  const { tenantId, userId } = (req as AuthenticatedRequest).auth!;
  if (!opts?.pool || !auditRepo) {
    res.status(503).json({ error: 'NOT_CONFIGURED' });
    return;
  }
  if (!(await subscriptionAllowsVoice(opts.pool, tenantId))) {
    res.status(402).json({ error: 'BILLING_REQUIRED' });
    return;
  }
  const body = await enableVoiceAgentLive(
    { pool: opts.pool, auditRepo },
    { tenantId, actorId: userId, source: 'manual' },
  );
  res.json(body);
});

router.post('/pause', requireAuth, requireTenant, async (req, res) => {
  // ... pauseVoiceAgentLive
});
```

- [ ] **Step 3: Wire pool in `app.ts`**

```ts
app.use('/api/voice', createVoiceRouter(voiceRepo, queue, transcribeAudio, auditRepo, voiceLogger, pool ? { pool } : undefined));
```

- [ ] **Step 4: Route tests with supertest + mock pool**

- [ ] **Step 5: Commit**

---

## Phase 5 — Telephony TwiML + fail-closed

### Task 5: `telephony.ts`

**Files:**
- Modify: `packages/api/src/routes/telephony.ts`
- Modify: `packages/api/test/telephony/telephony-voice-gate.test.ts`

- [ ] **Step 1: Extract helper**

```ts
function voicemailTwimlForGateReason(reason: VoiceGateResult['reason']): string {
  const say =
    reason === 'not_live'
      ? "This line isn't using our AI assistant yet. Please leave a message after the tone."
      : reason === 'no_billing'
        ? "We're finishing account setup. Please leave a message after the tone."
        : 'This number is being set up. Please leave a message after the tone.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${say}</Say><Record maxLength="120" playBeep="true"/><Hangup/></Response>`;
}
```

- [ ] **Step 2: Use on block**

```ts
if (!gate.allowed) {
  res.status(200).type('text/xml').send(voicemailTwimlForGateReason(gate.reason));
  return;
}
```

- [ ] **Step 3: Fail-closed on catch**

```ts
} catch (err) {
  logger.error('telephony/voice: voiceGate failed closed', { ... });
  res.status(200).type('text/xml').send(voicemailTwimlForGateReason('not_live'));
  return;
}
```

- [ ] **Step 4: Add test for `not_live` TwiML substring**

- [ ] **Step 5: Add test — throwing gate returns voicemail, store size 0**

- [ ] **Step 6: Commit**

---

## Phase 6 — Auto go-live on session end

### Task 6: `onSessionEnded` + adapter channel

**Files:**
- Modify: `packages/api/src/telephony/twilio-adapter.ts` — extend `onSessionEnded` payload with `channel: 'voice_inbound' | ...`
- Modify: `packages/api/src/app.ts`
- Create: `packages/api/test/integration/voice-go-live-auto.test.ts`

- [ ] **Step 1: Pass channel from `persistSessionEnded`**

```ts
await this.deps.onSessionEnded({
  tenantId: session.tenantId,
  channel: session.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
  ...
});
```

- [ ] **Step 2: Chain in app.ts**

```ts
onSessionEnded: async ({ tenantId, channel }) => {
  await checkAndFireUpgradeNudge({ pool }, tenantId);
  await maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId, channel: channel ?? 'voice_inbound' });
},
```

- [ ] **Step 3: Integration test**

Insert tenant with trialing + settings row, insert ended `voice_sessions` row, invoke `maybeAutoGoLiveOnInboundEnd`, assert `voice_agent_live_at` set.

Separate assertion: `POST /api/onboarding/test-call/skip` leaves `voice_agent_live_at` null.

- [ ] **Step 4: Commit**

---

## Phase 7 — Onboarding status `voiceAgentLive`

### Task 7: API + web types

**Files:**
- Modify: `packages/api/src/onboarding/load-facts.ts`, `derive-status.ts` (or map in route only)
- Modify: `packages/api/src/onboarding/contracts.ts`
- Modify: `packages/api/test/onboarding/contracts.test.ts`, `derive-status.test.ts`, `integration/onboarding-status.test.ts`
- Modify: `packages/web/src/types/onboarding.ts`
- Modify: `packages/web/src/hooks/useOnboardingStatus.test.ts`

- [ ] **Step 1: Extend Zod schema**

```ts
voiceAgentLive: z.boolean(),
```

- [ ] **Step 2: Load column in `load-facts.ts`**

Add to `tsRes` query: `voice_agent_live_at`.

- [ ] **Step 3: Set in `deriveOnboardingStatus` return**

```ts
voiceAgentLive: f.voiceAgentLiveAt != null,
```

- [ ] **Step 4: Run onboarding tests**

```bash
cd packages/api && npx vitest run test/onboarding test/integration/onboarding-status.test.ts
```

- [ ] **Step 5: Commit**

---

## Phase 8 — Web UX

### Task 8: TestCallStep + PhoneStep

**Files:**
- Modify: `packages/web/src/components/onboarding/v2/steps/TestCallStep.tsx`
- Modify: `packages/web/src/components/onboarding/v2/steps/PhoneStep.tsx`

- [ ] **Step 1: TestCallStep — use `status.voiceAgentLive`**

- Waiting state: show **Turn on AI answering** button → `POST /api/voice/go-live` → refetch status
- Done/skipped + `!voiceAgentLive`: title “Setup complete”, no “answering calls”
- Done/skipped + `voiceAgentLive`: keep celebration copy

- [ ] **Step 2: PhoneStep — one line under number**

- [ ] **Step 3: Manual smoke** (optional): `cd packages/web && npm test -- TestCallStep` if tests added

- [ ] **Step 4: Commit**

### Task 9: Settings toggle

**Files:**
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

- [ ] **Step 1: Add row** “AI phone answering” with switch calling go-live/pause; load initial state from `GET /api/onboarding/status` or small `GET /api/voice/status` if you add it (YAGNI: reuse onboarding status poll or one-shot fetch on mount).

- [ ] **Step 2: Commit**

---

## Phase 9 — Verification

### Task 10: Production typecheck + full voice test suite

- [ ] **Step 1: Typecheck (mandatory per CLAUDE.md)**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

- [ ] **Step 2: Run voice + onboarding + telephony tests**

```bash
cd packages/api && npx vitest run test/voice test/telephony/telephony-voice-gate.test.ts test/integration/onboarding test/routes/voice-go-live.test.ts
```

- [ ] **Step 3: Amend spec migration label (optional doc fix)**

In `2026-05-20-voice-go-live-gate-design.md`, change `100_*` → `106_*` in §2 and §5.

- [ ] **Step 4: Final commit + PR update**

---

## Spec coverage checklist

| Spec § | Task |
|--------|------|
| Migration `voice_agent_live_at` | Task 1 (`106_*`) |
| Gate order A → go-live → B | Task 3 |
| `POST go-live` / `pause` | Task 4 |
| Auto on inbound end | Task 6 |
| Skip does not set live | Task 6 integration |
| `voiceAgentLive` on status | Task 7 |
| TestCallStep / PhoneStep | Task 8 |
| Settings toggle | Task 9 |
| Distinct TwiML | Task 5 |
| Fail-closed | Task 5 |
| Audit + metrics `not_live` | Task 3 |
| Success criteria 1–5 | Tasks 3, 5, 6, 8, 10 |

---

## Execution options

**Plan saved to:** `docs/superpowers/plans/2026-05-20-voice-go-live-gate.md`

1. **Subagent-driven** — fresh subagent per task, review between tasks  
2. **Inline** — execute in this session with checkpoints  

Which approach do you want?
