# §10 Onboarding & Self-Serve Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stitch the existing onboarding fragments (Clerk bootstrap, business-identity form, vertical-pack seeding, Twilio provisioning, Stripe billing) into one resumable 6-step `/onboarding` flow with a sidebar UI, layered trial-fraud gates at the voice webhook, and a 30-minute early-upgrade nudge.

**Architecture:** Resumability is **derived** from real entities (no `onboarding_progress` table). One new endpoint `GET /api/onboarding/status` composes the truth from `tenant_settings`, `tenant_packs`, `tenant_integrations`, `tenants.subscription_status`, and `voice_sessions`. The frontend polls it; an app-shell guard redirects to `/onboarding` while incomplete. Voice abuse is bounded by a subscription-status gate plus a 60-min/day + 100-min-trial-total AI cap at the inbound webhook.

**Tech Stack:** TypeScript, Node 20, Express, Postgres (raw `pg.Pool`), Zod, React 18, Vite, Tailwind, Radix, Clerk, Stripe, Twilio, Vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-15-onboarding-self-serve-setup-design.md`](../specs/2026-05-15-onboarding-self-serve-setup-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `packages/api/src/db/migrations/073_tenant_settings_onboarding_fields.sql` | Additive ALTER on `tenant_settings` |
| `packages/shared/src/contracts/onboarding.ts` | Zod schemas + types for status + inputs |
| `packages/api/src/onboarding/derive-status.ts` | Pure function: entity snapshot → `OnboardingStatusResponse` |
| `packages/api/src/onboarding/derive-status.test.ts` | Unit tests for above |
| `packages/api/src/voice/trial-limits.ts` | Constants + pure cap evaluator |
| `packages/api/src/voice/trial-limits.test.ts` | Unit tests for cap evaluator |
| `packages/api/src/voice/outbound-allowlist.ts` | Gate C constants + checker (passive — no live integration) |
| `packages/api/src/voice/outbound-allowlist.test.ts` | Unit tests for allowlist |
| `packages/web/src/components/onboarding/OnboardingShell.tsx` | New sidebar layout |
| `packages/web/src/components/onboarding/Sidebar.tsx` | Step list with status icons |
| `packages/web/src/components/onboarding/steps/IdentityStep.tsx` | Step 2 form |
| `packages/web/src/components/onboarding/steps/PackStep.tsx` | Step 3 picker |
| `packages/web/src/components/onboarding/steps/PhoneStep.tsx` | Step 4 with polling |
| `packages/web/src/components/onboarding/steps/BillingStep.tsx` | Step 5 Stripe launcher |
| `packages/web/src/components/onboarding/steps/TestCallStep.tsx` | Step 6 + "You're live" |
| `packages/web/src/components/onboarding/steps/OptionalSteps.tsx` | Terminology + automation, post-go-live |
| `packages/web/src/hooks/useOnboardingStatus.ts` | SWR-style polling hook |
| `packages/web/src/components/UpgradeNudgeBanner.tsx` | One-time conversion banner |
| `e2e/onboarding-v2.spec.ts` | Full Playwright journey |

### Modified files

| Path | Change |
|---|---|
| `packages/api/src/routes/onboarding.ts` | Add 4 new routes; keep old `/configure` behind flag |
| `packages/api/src/routes/billing.ts` | Add `POST /end-trial-now` (or create file if absent) |
| `packages/api/src/voice/<inbound entry>` | Insert Gate A + Gate B at top of handler (discover exact file in Task 10) |
| `packages/api/src/monitoring/metrics.ts` | Add 3 new Prom counters |
| `packages/api/src/shared/config.ts` | Add `ONBOARDING_V2_ENABLED`, trial-cap override env vars |
| `packages/web/src/routes.ts` | Point `/onboarding` at `OnboardingShell` (under flag) |
| `packages/web/src/components/ProtectedRoute.tsx` (or equivalent) | Add `isComplete` guard that redirects to `/onboarding` |
| `.env.example` | Document new env vars |

---

# Phase 1 — Foundation

## Task 1: Schema migration 073

**Files:**
- Create: `packages/api/src/db/migrations/073_tenant_settings_onboarding_fields.sql`
- Create: `packages/api/test/db/migration-073.test.ts`

- [ ] **Step 1: Confirm migration number is unused**

Run: `ls packages/api/src/db/migrations/ | tail -5`

Expected: highest existing number is `072_*`. If a `073_*` already exists, bump to the next free number and update all references in this plan.

- [ ] **Step 2: Write the failing migration test**

```ts
// packages/api/test/db/migration-073.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migration 073 — tenant_settings onboarding fields', () => {
  const sql = readFileSync(
    join(__dirname, '../../src/db/migrations/073_tenant_settings_onboarding_fields.sql'),
    'utf8'
  );

  it('adds business_hours JSONB with default', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS business_hours\s+JSONB\s+NOT NULL DEFAULT '\{\}'/);
  });
  it('adds job_buffer_minutes INT with default 30', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS job_buffer_minutes\s+INT\s+NOT NULL DEFAULT 30/);
  });
  it('adds hourly_rate_cents INT (nullable)', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hourly_rate_cents\s+INT[^N]/);
  });
  it('adds service_area_text and service_area_radius', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS service_area_text\s+TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS service_area_radius\s+INT/);
  });
  it('adds onboarding_test_call_skipped_at + onboarding_upgrade_prompt_shown_at', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS onboarding_test_call_skipped_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS onboarding_upgrade_prompt_shown_at\s+TIMESTAMPTZ/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/db/migration-073.test.ts`
Expected: FAIL with ENOENT (file doesn't exist).

- [ ] **Step 4: Write the migration SQL**

```sql
-- packages/api/src/db/migrations/073_tenant_settings_onboarding_fields.sql
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS business_hours      JSONB       NOT NULL DEFAULT '{}';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_text   TEXT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS service_area_radius INT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS job_buffer_minutes  INT         NOT NULL DEFAULT 30;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS hourly_rate_cents   INT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_test_call_skipped_at      TIMESTAMPTZ;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS onboarding_upgrade_prompt_shown_at   TIMESTAMPTZ;
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd packages/api && npx vitest run test/db/migration-073.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run migration dry-run against dev DB**

Run: `npm run migrate:dryrun`
Expected: dry-run lists migration 073 as pending; no errors. **Do not apply yet** — Task 21 applies it under the flag rollout.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/db/migrations/073_tenant_settings_onboarding_fields.sql packages/api/test/db/migration-073.test.ts
git commit -m "feat(onboarding): migration 073 add onboarding fields to tenant_settings"
```

---

## Task 2: Shared contracts

**Files:**
- Create: `packages/shared/src/contracts/onboarding.ts`
- Create: `packages/shared/test/contracts/onboarding.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
// packages/shared/test/contracts/onboarding.test.ts
import { describe, it, expect } from 'vitest';
import {
  BusinessIdentityInputSchema,
  PackPickInputSchema,
  OnboardingStatusResponseSchema,
} from '../../src/contracts/onboarding';

describe('BusinessIdentityInputSchema', () => {
  it('accepts a complete valid payload', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'Acme HVAC',
      serviceAreaText: 'Austin, TX',
      serviceAreaRadius: 25,
      businessHours: {
        mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' },
        wed: { open: '08:00', close: '17:00' }, thu: { open: '08:00', close: '17:00' },
        fri: { open: '08:00', close: '17:00' }, sat: null, sun: null,
      },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
    });
    expect(result.success).toBe(true);
  });
  it('rejects empty business name', () => {
    const result = BusinessIdentityInputSchema.safeParse({ businessName: '', businessHours: {}, jobBufferMinutes: 30, hourlyRateCents: 10000 });
    expect(result.success).toBe(false);
  });
  it('rejects hourly_rate_cents below 100', () => {
    const result = BusinessIdentityInputSchema.safeParse({ businessName: 'A', businessHours: {}, jobBufferMinutes: 30, hourlyRateCents: 50 });
    expect(result.success).toBe(false);
  });
  it('rejects bad business_hours time format', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'A', businessHours: { mon: { open: '8am', close: '5pm' } },
      jobBufferMinutes: 30, hourlyRateCents: 10000,
    });
    expect(result.success).toBe(false);
  });
});

describe('PackPickInputSchema', () => {
  it('accepts hvac and plumbing only', () => {
    expect(PackPickInputSchema.safeParse({ packId: 'hvac' }).success).toBe(true);
    expect(PackPickInputSchema.safeParse({ packId: 'plumbing' }).success).toBe(true);
    expect(PackPickInputSchema.safeParse({ packId: 'electrical' }).success).toBe(false);
  });
});

describe('OnboardingStatusResponseSchema', () => {
  it('round-trips a complete response', () => {
    const value = {
      steps: [
        { id: 'signup' as const, status: 'done' as const },
        { id: 'identity' as const, status: 'done' as const },
        { id: 'pack' as const, status: 'current' as const },
        { id: 'phone' as const, status: 'pending' as const },
        { id: 'billing' as const, status: 'pending' as const },
        { id: 'test_call' as const, status: 'pending' as const },
      ],
      currentStep: 'pack' as const,
      isComplete: false,
    };
    expect(OnboardingStatusResponseSchema.parse(value)).toEqual(value);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run test/contracts/onboarding.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement contracts**

```ts
// packages/shared/src/contracts/onboarding.ts
import { z } from 'zod';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const DayHours = z.object({ open: TimeOfDay, close: TimeOfDay }).nullable();
export const BusinessHoursSchema = z.object({
  mon: DayHours.optional(), tue: DayHours.optional(), wed: DayHours.optional(),
  thu: DayHours.optional(), fri: DayHours.optional(), sat: DayHours.optional(),
  sun: DayHours.optional(),
}).default({});

export const BusinessIdentityInputSchema = z.object({
  businessName:        z.string().min(1).max(120),
  serviceAreaText:     z.string().max(200).optional(),
  serviceAreaRadius:   z.number().int().min(1).max(500).optional(),
  businessHours:       BusinessHoursSchema,
  jobBufferMinutes:    z.number().int().min(0).max(240),
  hourlyRateCents:     z.number().int().min(100).max(100_000),
});
export type BusinessIdentityInput = z.infer<typeof BusinessIdentityInputSchema>;

export const PackPickInputSchema = z.object({
  packId: z.enum(['hvac', 'plumbing']),
});
export type PackPickInput = z.infer<typeof PackPickInputSchema>;

export const OnboardingStepIdSchema = z.enum(['signup', 'identity', 'pack', 'phone', 'billing', 'test_call']);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;
export const OnboardingStepStatusSchema = z.enum(['done', 'current', 'pending', 'error', 'skipped']);
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>;

export const OnboardingStepSchema = z.object({
  id: OnboardingStepIdSchema,
  status: OnboardingStepStatusSchema,
  blockers: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const OnboardingStatusResponseSchema = z.object({
  steps: z.array(OnboardingStepSchema).length(6),
  currentStep: OnboardingStepIdSchema.nullable(),
  isComplete: z.boolean(),
});
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponseSchema>;
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd packages/shared && npx vitest run test/contracts/onboarding.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts/onboarding.ts packages/shared/test/contracts/onboarding.test.ts
git commit -m "feat(onboarding): shared Zod contracts for identity, pack, status"
```

---

## Task 3: deriveOnboardingStatus pure function

**Files:**
- Create: `packages/api/src/onboarding/derive-status.ts`
- Create: `packages/api/src/onboarding/derive-status.test.ts`

- [ ] **Step 1: Write the failing test (10 cases)**

```ts
// packages/api/src/onboarding/derive-status.test.ts
import { describe, it, expect } from 'vitest';
import { deriveOnboardingStatus, type OnboardingFacts } from './derive-status';

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantExists: true,
    identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null },
    packActivated: false,
    twilioStatus: null,
    subscription: { stripeSubscriptionId: null, status: null },
    inboundCallCount: 0,
    testCallSkippedAt: null,
    ...overrides,
  };
}

describe('deriveOnboardingStatus', () => {
  it('fresh tenant: only signup done, identity is current', () => {
    const r = deriveOnboardingStatus(facts());
    expect(r.steps[0]).toEqual({ id: 'signup', status: 'done' });
    expect(r.steps[1]).toEqual({ id: 'identity', status: 'current' });
    expect(r.currentStep).toBe('identity');
    expect(r.isComplete).toBe(false);
  });

  it('identity done: pack becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
    }));
    expect(r.steps[1].status).toBe('done');
    expect(r.steps[2].status).toBe('current');
    expect(r.currentStep).toBe('pack');
  });

  it('identity partial (no hourly rate): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: null },
    }));
    expect(r.steps[1].status).toBe('current');
  });

  it('pack activated: phone becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
    }));
    expect(r.steps[2].status).toBe('done');
    expect(r.steps[3].status).toBe('current');
  });

  it('phone provisioning: phone is current (not done)', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'provisioning',
    }));
    expect(r.steps[3].status).toBe('current');
  });

  it('phone full_readiness: billing becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'full_readiness',
    }));
    expect(r.steps[3].status).toBe('done');
    expect(r.steps[4].status).toBe('current');
  });

  it('phone failed: phone is error with blocker', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'failed',
    }));
    expect(r.steps[3].status).toBe('error');
    expect(r.steps[3].blockers).toBeDefined();
  });

  it('subscription trialing: billing done, test_call current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    }));
    expect(r.steps[4].status).toBe('done');
    expect(r.steps[5].status).toBe('current');
  });

  it('inbound call recorded: test_call done, complete=true', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      inboundCallCount: 1,
    }));
    expect(r.steps[5].status).toBe('done');
    expect(r.isComplete).toBe(true);
    expect(r.currentStep).toBeNull();
  });

  it('test call skipped: test_call=skipped, complete=true', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      testCallSkippedAt: new Date(),
    }));
    expect(r.steps[5].status).toBe('skipped');
    expect(r.isComplete).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/api && npx vitest run src/onboarding/derive-status.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the pure function**

```ts
// packages/api/src/onboarding/derive-status.ts
import type {
  OnboardingStatusResponse,
  OnboardingStepId,
  OnboardingStepStatus,
} from '@serviceos/shared/contracts/onboarding';

export interface OnboardingFacts {
  tenantExists: boolean;
  identity: {
    businessName: string | null;
    businessHours: unknown | null;     // null OR an empty object {} both count as "not set"
    jobBufferMinutes: number | null;
    hourlyRateCents: number | null;
  };
  packActivated: boolean;
  twilioStatus: 'pending' | 'provisioning' | 'full_readiness' | 'failed' | null;
  subscription: {
    stripeSubscriptionId: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | null;
  };
  inboundCallCount: number;
  testCallSkippedAt: Date | null;
}

const isIdentityDone = (i: OnboardingFacts['identity']) =>
  !!i.businessName &&
  i.jobBufferMinutes !== null &&
  i.hourlyRateCents !== null &&
  i.businessHours !== null &&
  typeof i.businessHours === 'object' &&
  Object.keys(i.businessHours as object).length > 0;

const isBillingDone = (s: OnboardingFacts['subscription']) =>
  !!s.stripeSubscriptionId && (s.status === 'trialing' || s.status === 'active');

const isTestCallDone = (f: OnboardingFacts) => f.inboundCallCount > 0;
const isTestCallSkipped = (f: OnboardingFacts) => f.testCallSkippedAt !== null && f.inboundCallCount === 0;

export function deriveOnboardingStatus(f: OnboardingFacts): OnboardingStatusResponse {
  const done = {
    signup:    f.tenantExists,
    identity:  isIdentityDone(f.identity),
    pack:      f.packActivated,
    phone:     f.twilioStatus === 'full_readiness',
    billing:   isBillingDone(f.subscription),
    test_call: isTestCallDone(f) || isTestCallSkipped(f),
  };

  const order: OnboardingStepId[] = ['signup', 'identity', 'pack', 'phone', 'billing', 'test_call'];
  const firstNotDone = order.find((id) => !done[id]) ?? null;

  const steps = order.map((id): { id: OnboardingStepId; status: OnboardingStepStatus; blockers?: string[] } => {
    if (id === 'phone' && f.twilioStatus === 'failed') {
      return { id, status: 'error', blockers: ['twilio_provisioning_failed'] };
    }
    if (id === 'test_call' && isTestCallSkipped(f)) return { id, status: 'skipped' };
    if (done[id]) return { id, status: 'done' };
    if (id === firstNotDone) return { id, status: 'current' };
    return { id, status: 'pending' };
  });

  return {
    steps,
    currentStep: firstNotDone,
    isComplete: firstNotDone === null,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/api && npx vitest run src/onboarding/derive-status.test.ts`
Expected: all 10 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/onboarding/
git commit -m "feat(onboarding): pure deriveOnboardingStatus from entity snapshot"
```

---

# Phase 2 — Backend endpoints

## Task 4: GET /api/onboarding/status

**Files:**
- Create: `packages/api/src/onboarding/load-facts.ts` (composes the snapshot from repos)
- Modify: `packages/api/src/routes/onboarding.ts` (add the route)
- Create: `packages/api/test/integration/onboarding/status.integration.test.ts`

- [ ] **Step 1: Grep for the existing tenant/voice/integrations queries**

Run: `grep -rn "FROM tenant_integrations\|FROM voice_sessions\|stripe_subscription_id" packages/api/src/ | head -20`

Expected output: discover the existing query helpers for these entities so the new `load-facts.ts` reuses them rather than duplicating SQL.

- [ ] **Step 2: Write the integration test**

```ts
// packages/api/test/integration/onboarding/status.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { runMigrations } from '../../helpers/run-migrations';
import { createOnboardingRouter } from '../../../src/routes/onboarding';
import { mockAuthMiddleware } from '../../helpers/mock-auth';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: express.Express;
const tenantId = '00000000-0000-0000-0000-000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer().start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  app = express();
  app.use(express.json());
  app.use(mockAuthMiddleware({ tenantId, userId: 'u1' }));
  app.use('/api/onboarding', createOnboardingRouter({ pool }));
}, 60_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE tenants, tenant_settings, tenant_packs, tenant_integrations, voice_sessions CASCADE');
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'Test')", [tenantId]);
  await pool.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId]);
});

describe('GET /api/onboarding/status', () => {
  it('returns identity as current step for a fresh tenant', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe('identity');
    expect(res.body.isComplete).toBe(false);
    expect(res.body.steps).toHaveLength(6);
  });

  it('marks identity done when all four fields present', async () => {
    await pool.query(
      `UPDATE tenant_settings SET business_name=$2, business_hours=$3, job_buffer_minutes=$4, hourly_rate_cents=$5 WHERE tenant_id=$1`,
      [tenantId, 'Acme', JSON.stringify({ mon: null }), 30, 12500]
    );
    const res = await request(app).get('/api/onboarding/status');
    expect(res.body.steps.find((s: any) => s.id === 'identity').status).toBe('done');
    expect(res.body.currentStep).toBe('pack');
  });

  it('isComplete=true when all steps done', async () => {
    await pool.query(
      `UPDATE tenant_settings SET business_name=$2, business_hours=$3, job_buffer_minutes=$4, hourly_rate_cents=$5 WHERE tenant_id=$1`,
      [tenantId, 'Acme', JSON.stringify({ mon: null }), 30, 12500]
    );
    await pool.query(`INSERT INTO tenant_packs (tenant_id, pack_id, status) VALUES ($1, 'hvac', 'active')`, [tenantId]);
    await pool.query(`INSERT INTO tenant_integrations (tenant_id, provider, status) VALUES ($1, 'twilio', 'full_readiness')`, [tenantId]);
    await pool.query(`UPDATE tenants SET stripe_subscription_id='sub_1', subscription_status='trialing' WHERE id=$1`, [tenantId]);
    await pool.query(`INSERT INTO voice_sessions (id, tenant_id, channel, started_at, ended_at) VALUES (gen_random_uuid(), $1, 'voice_inbound', now() - interval '1 minute', now())`, [tenantId]);
    const res = await request(app).get('/api/onboarding/status');
    expect(res.body.isComplete).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd packages/api && npx vitest run test/integration/onboarding/status.integration.test.ts`
Expected: FAIL (route + helpers don't exist).

- [ ] **Step 4: Implement load-facts.ts**

```ts
// packages/api/src/onboarding/load-facts.ts
import type { Pool } from 'pg';
import type { OnboardingFacts } from './derive-status';

export async function loadOnboardingFacts(pool: Pool, tenantId: string): Promise<OnboardingFacts> {
  const [settingsRes, packsRes, integRes, tenantRes, callsRes] = await Promise.all([
    pool.query(
      `SELECT business_name, business_hours, job_buffer_minutes, hourly_rate_cents, onboarding_test_call_skipped_at
         FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId]
    ),
    pool.query(`SELECT 1 FROM tenant_packs WHERE tenant_id=$1 AND status='active' LIMIT 1`, [tenantId]),
    pool.query(`SELECT status FROM tenant_integrations WHERE tenant_id=$1 AND provider='twilio' LIMIT 1`, [tenantId]),
    pool.query(`SELECT stripe_subscription_id, subscription_status FROM tenants WHERE id=$1`, [tenantId]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_sessions
         WHERE tenant_id=$1 AND channel='voice_inbound' AND ended_at IS NOT NULL`,
      [tenantId]
    ),
  ]);

  const s = settingsRes.rows[0] ?? {};
  const t = tenantRes.rows[0] ?? {};
  return {
    tenantExists: !!tenantRes.rows[0],
    identity: {
      businessName: s.business_name ?? null,
      businessHours: s.business_hours ?? null,
      jobBufferMinutes: s.job_buffer_minutes ?? null,
      hourlyRateCents: s.hourly_rate_cents ?? null,
    },
    packActivated: packsRes.rows.length > 0,
    twilioStatus: integRes.rows[0]?.status ?? null,
    subscription: {
      stripeSubscriptionId: t.stripe_subscription_id ?? null,
      status: t.subscription_status ?? null,
    },
    inboundCallCount: callsRes.rows[0]?.n ?? 0,
    testCallSkippedAt: s.onboarding_test_call_skipped_at ?? null,
  };
}
```

- [ ] **Step 5: Add the route to `packages/api/src/routes/onboarding.ts`**

Add (preserving the existing `createOnboardingRouter` factory; if the existing signature uses individual repos, extend it to accept a `pool` field):

```ts
import { loadOnboardingFacts } from '../onboarding/load-facts';
import { deriveOnboardingStatus } from '../onboarding/derive-status';

router.get('/status', requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const facts = await loadOnboardingFacts(deps.pool, tenantId);
  const status = deriveOnboardingStatus(facts);
  res.set('Cache-Control', 'private, max-age=2');
  res.json(status);
});
```

- [ ] **Step 6: Run integration test**

Run: `cd packages/api && npx vitest run test/integration/onboarding/status.integration.test.ts`
Expected: all 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/onboarding/load-facts.ts packages/api/src/routes/onboarding.ts packages/api/test/integration/onboarding/status.integration.test.ts
git commit -m "feat(onboarding): GET /api/onboarding/status — derived from entity snapshot"
```

---

## Task 5: PUT /api/onboarding/identity

**Files:**
- Modify: `packages/api/src/routes/onboarding.ts`
- Create: `packages/api/test/integration/onboarding/identity.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/test/integration/onboarding/identity.integration.test.ts
// (Same setup as status.integration.test.ts — extract shared setup to a helper if convenient.)
describe('PUT /api/onboarding/identity', () => {
  it('rejects payload missing businessName with 400', async () => {
    const res = await request(app).put('/api/onboarding/identity').send({ businessHours: {}, jobBufferMinutes: 30, hourlyRateCents: 10000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
  it('upserts on valid payload and step 2 becomes done', async () => {
    const payload = {
      businessName: 'Acme HVAC', serviceAreaText: 'Austin, TX', serviceAreaRadius: 25,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 45, hourlyRateCents: 15000,
    };
    const res = await request(app).put('/api/onboarding/identity').send(payload);
    expect(res.status).toBe(200);

    const status = await request(app).get('/api/onboarding/status');
    expect(status.body.steps.find((s: any) => s.id === 'identity').status).toBe('done');

    const dbRow = await pool.query('SELECT * FROM tenant_settings WHERE tenant_id=$1', [tenantId]);
    expect(dbRow.rows[0].business_name).toBe('Acme HVAC');
    expect(dbRow.rows[0].hourly_rate_cents).toBe(15000);
  });
  it('emits a tenant.identity_set audit event', async () => {
    await request(app).put('/api/onboarding/identity').send({
      businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000,
    });
    const ev = await pool.query("SELECT * FROM audit_events WHERE tenant_id=$1 AND event_type='tenant.identity_set'", [tenantId]);
    expect(ev.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/api && npx vitest run test/integration/onboarding/identity.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```ts
// packages/api/src/routes/onboarding.ts (add)
import { BusinessIdentityInputSchema } from '@serviceos/shared/contracts/onboarding';

router.put('/identity', requireAuth, requireTenant, async (req, res) => {
  const parsed = BusinessIdentityInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    return;
  }
  const tenantId = req.auth!.tenantId;
  const v = parsed.data;
  await deps.pool.query(
    `UPDATE tenant_settings
        SET business_name=$2, service_area_text=$3, service_area_radius=$4,
            business_hours=$5::jsonb, job_buffer_minutes=$6, hourly_rate_cents=$7,
            updated_at=now()
      WHERE tenant_id=$1`,
    [tenantId, v.businessName, v.serviceAreaText ?? null, v.serviceAreaRadius ?? null,
     JSON.stringify(v.businessHours), v.jobBufferMinutes, v.hourlyRateCents]
  );
  await deps.auditRepo.create(createAuditEvent({
    tenantId, actorId: req.auth!.userId, actorRole: 'owner',
    eventType: 'tenant.identity_set', entityType: 'tenant_settings', entityId: tenantId,
    metadata: { businessName: v.businessName, hourlyRateCents: v.hourlyRateCents },
  }));
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2. Expected: all 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/onboarding.ts packages/api/test/integration/onboarding/identity.integration.test.ts
git commit -m "feat(onboarding): PUT /api/onboarding/identity upserts tenant_settings"
```

---

## Task 6: POST /api/onboarding/pack

**Files:**
- Modify: `packages/api/src/routes/onboarding.ts`
- Create: `packages/api/test/integration/onboarding/pack.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('POST /api/onboarding/pack', () => {
  it('rejects unknown packId', async () => {
    const res = await request(app).post('/api/onboarding/pack').send({ packId: 'electrical' });
    expect(res.status).toBe(400);
  });
  it('activates the pack and is idempotent', async () => {
    const r1 = await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    expect(r2.status).toBe(200);
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM tenant_packs WHERE tenant_id=$1 AND pack_id='hvac' AND status='active'`, [tenantId]);
    expect(rows.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail.**

Run: `npx vitest run test/integration/onboarding/pack.integration.test.ts`

- [ ] **Step 3: Implement**

```ts
import { PackPickInputSchema } from '@serviceos/shared/contracts/onboarding';
import { activatePack } from '../settings/pack-activation';

router.post('/pack', requireAuth, requireTenant, async (req, res) => {
  const parsed = PackPickInputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'VALIDATION_ERROR' }); return; }
  const tenantId = req.auth!.tenantId;
  await activatePack(deps.pool, tenantId, parsed.data.packId); // existing fn — idempotent
  await deps.auditRepo.create(createAuditEvent({
    tenantId, actorId: req.auth!.userId, actorRole: 'owner',
    eventType: 'tenant.pack_activated', entityType: 'tenant_packs', entityId: parsed.data.packId,
    metadata: { packId: parsed.data.packId },
  }));
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run to verify pass + commit.**

```bash
git add packages/api/src/routes/onboarding.ts packages/api/test/integration/onboarding/pack.integration.test.ts
git commit -m "feat(onboarding): POST /api/onboarding/pack activates HVAC or Plumbing"
```

---

## Task 7: POST /api/onboarding/test-call/skip

**Files:** Modify `packages/api/src/routes/onboarding.ts`; create test file alongside.

- [ ] **Step 1: Test**

```ts
describe('POST /api/onboarding/test-call/skip', () => {
  it('sets onboarding_test_call_skipped_at and marks step 6 skipped', async () => {
    // seed everything done EXCEPT test call
    await pool.query(`UPDATE tenant_settings SET business_name='A', business_hours='{"mon":null}', job_buffer_minutes=30, hourly_rate_cents=10000 WHERE tenant_id=$1`, [tenantId]);
    await pool.query(`INSERT INTO tenant_packs (tenant_id, pack_id, status) VALUES ($1, 'hvac', 'active')`, [tenantId]);
    await pool.query(`INSERT INTO tenant_integrations (tenant_id, provider, status) VALUES ($1, 'twilio', 'full_readiness')`, [tenantId]);
    await pool.query(`UPDATE tenants SET stripe_subscription_id='sub_1', subscription_status='trialing' WHERE id=$1`, [tenantId]);
    const res = await request(app).post('/api/onboarding/test-call/skip');
    expect(res.status).toBe(200);
    expect(res.body.isComplete).toBe(true);
    expect(res.body.steps.find((s:any)=>s.id==='test_call').status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run + fail. Step 3: Implement.**

```ts
router.post('/test-call/skip', requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId;
  await deps.pool.query(`UPDATE tenant_settings SET onboarding_test_call_skipped_at = now() WHERE tenant_id = $1`, [tenantId]);
  await deps.auditRepo.create(createAuditEvent({
    tenantId, actorId: req.auth!.userId, actorRole: 'owner',
    eventType: 'tenant.test_call_skipped', entityType: 'tenant_settings', entityId: tenantId, metadata: {},
  }));
  const facts = await loadOnboardingFacts(deps.pool, tenantId);
  res.json(deriveOnboardingStatus(facts));
});
```

- [ ] **Step 4: Run + pass + commit.**

```bash
git commit -m "feat(onboarding): POST /api/onboarding/test-call/skip records soft skip"
```

---

## Task 8: Billing checkout + end-trial-now

**Files:**
- Modify (or create): `packages/api/src/routes/billing.ts`
- Modify: `packages/api/src/routes/onboarding.ts`
- Create: `packages/api/test/integration/billing/end-trial-now.integration.test.ts`

- [ ] **Step 1: Locate the Stripe client wrapper.**

Run: `grep -rn "new Stripe(\|stripe.subscriptions\|stripe.checkout" packages/api/src/ | head -10`
Expected: find the Stripe SDK initialization and existing call sites.

- [ ] **Step 2: Test for end-trial-now**

```ts
describe('POST /api/billing/end-trial-now', () => {
  it('calls Stripe to set trial_end=now and audits', async () => {
    const stripeMock = { subscriptions: { update: vi.fn().mockResolvedValue({ id: 'sub_1', status: 'active' }) } };
    // ... wire stripeMock into createBillingRouter via deps injection
    await pool.query(`UPDATE tenants SET stripe_subscription_id='sub_1', subscription_status='trialing' WHERE id=$1`, [tenantId]);
    const res = await request(app).post('/api/billing/end-trial-now');
    expect(res.status).toBe(200);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_1', { trial_end: 'now', proration_behavior: 'create_prorations' });
  });
  it('returns 409 if no subscription on file', async () => {
    const res = await request(app).post('/api/billing/end-trial-now');
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run + fail.**

- [ ] **Step 4: Implement both endpoints**

```ts
// packages/api/src/routes/billing.ts (add)
router.post('/end-trial-now', requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const t = await deps.pool.query(`SELECT stripe_subscription_id FROM tenants WHERE id=$1`, [tenantId]);
  const subId = t.rows[0]?.stripe_subscription_id;
  if (!subId) { res.status(409).json({ error: 'NO_SUBSCRIPTION' }); return; }
  await deps.stripe.subscriptions.update(subId, { trial_end: 'now', proration_behavior: 'create_prorations' });
  await deps.auditRepo.create(createAuditEvent({
    tenantId, actorId: req.auth!.userId, actorRole: 'owner',
    eventType: 'tenant.trial_ended_early', entityType: 'subscription', entityId: subId, metadata: {},
  }));
  res.json({ ok: true });
});
```

```ts
// packages/api/src/routes/onboarding.ts (add)
router.post('/billing/checkout-session', requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const session = await deps.stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: deps.config.STRIPE_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 14, metadata: { tenantId } },
    payment_method_collection: 'always',
    customer_email: req.auth!.userEmail,  // if the auth middleware doesn't expose userEmail, fetch it from Clerk via clerkClient.users.getUser(req.auth!.userId) — locate the existing Clerk client export with `grep -rn "clerkClient\|clerk.users.getUser" packages/api/src/`
    success_url: `${deps.config.WEB_URL}/onboarding?billing=ok`,
    cancel_url:  `${deps.config.WEB_URL}/onboarding?billing=cancel`,
    client_reference_id: tenantId,
  });
  res.json({ url: session.url });
});
```

- [ ] **Step 5: Run + pass + commit.**

```bash
git commit -m "feat(billing): checkout session + end-trial-now for early upgrade"
```

---

# Phase 3 — Voice gates

## Task 9: trial-limits.ts + cap evaluator

**Files:**
- Create: `packages/api/src/voice/trial-limits.ts`
- Create: `packages/api/src/voice/trial-limits.test.ts`

- [ ] **Step 1: Test the pure evaluator (8 cases)**

```ts
// packages/api/src/voice/trial-limits.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateTrialCap, TRIAL_LIMITS } from './trial-limits';

describe('evaluateTrialCap', () => {
  it('allows when not trialing (active subscription)', () => {
    const r = evaluateTrialCap({ status: 'active', dailyMinutes: 999, trialTotalMinutes: 999, concurrentCalls: 99 });
    expect(r.allowed).toBe(true);
  });
  it('blocks when no subscription', () => {
    const r = evaluateTrialCap({ status: null, dailyMinutes: 0, trialTotalMinutes: 0, concurrentCalls: 0 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_billing');
  });
  it('blocks when status canceled or past_due', () => {
    expect(evaluateTrialCap({ status: 'canceled', dailyMinutes:0, trialTotalMinutes:0, concurrentCalls:0 }).reason).toBe('no_billing');
    expect(evaluateTrialCap({ status: 'past_due', dailyMinutes:0, trialTotalMinutes:0, concurrentCalls:0 }).reason).toBe('no_billing');
  });
  it('blocks when trialing and daily cap reached', () => {
    const r = evaluateTrialCap({ status:'trialing', dailyMinutes: TRIAL_LIMITS.DAILY_MINUTES, trialTotalMinutes:0, concurrentCalls:0 });
    expect(r.allowed).toBe(false); expect(r.reason).toBe('trial_cap_daily');
  });
  it('blocks when trialing and trial total reached', () => {
    const r = evaluateTrialCap({ status:'trialing', dailyMinutes:0, trialTotalMinutes: TRIAL_LIMITS.TRIAL_TOTAL_MINUTES, concurrentCalls:0 });
    expect(r.allowed).toBe(false); expect(r.reason).toBe('trial_cap_total');
  });
  it('blocks when concurrent cap reached', () => {
    const r = evaluateTrialCap({ status:'trialing', dailyMinutes:0, trialTotalMinutes:0, concurrentCalls: TRIAL_LIMITS.CONCURRENT_CALLS });
    expect(r.allowed).toBe(false); expect(r.reason).toBe('trial_cap_concurrent');
  });
  it('allows when trialing and well under all caps', () => {
    expect(evaluateTrialCap({ status:'trialing', dailyMinutes:5, trialTotalMinutes:10, concurrentCalls:0 }).allowed).toBe(true);
  });
  it('respects env override for daily cap', () => {
    process.env.TRIAL_VOICE_MINUTES_DAILY_OVERRIDE = '5';
    expect(evaluateTrialCap({ status:'trialing', dailyMinutes:6, trialTotalMinutes:0, concurrentCalls:0 }).reason).toBe('trial_cap_daily');
    delete process.env.TRIAL_VOICE_MINUTES_DAILY_OVERRIDE;
  });
});
```

- [ ] **Step 2: Run + fail.**

- [ ] **Step 3: Implement**

```ts
// packages/api/src/voice/trial-limits.ts
export const TRIAL_LIMITS = {
  DAILY_MINUTES: 60,
  TRIAL_TOTAL_MINUTES: 100,
  CONCURRENT_CALLS: 2,
} as const;

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | null;
export type GateReason = 'no_billing' | 'trial_cap_daily' | 'trial_cap_total' | 'trial_cap_concurrent';

interface TrialCapInput {
  status: SubscriptionStatus;
  dailyMinutes: number;
  trialTotalMinutes: number;
  concurrentCalls: number;
}

export interface TrialCapResult {
  allowed: boolean;
  reason?: GateReason;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function evaluateTrialCap(input: TrialCapInput): TrialCapResult {
  if (input.status !== 'trialing' && input.status !== 'active') {
    return { allowed: false, reason: 'no_billing' };
  }
  if (input.status === 'active') return { allowed: true };
  // trialing — apply caps
  const dailyCap = envInt('TRIAL_VOICE_MINUTES_DAILY_OVERRIDE', TRIAL_LIMITS.DAILY_MINUTES);
  const totalCap = envInt('TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE', TRIAL_LIMITS.TRIAL_TOTAL_MINUTES);
  if (input.dailyMinutes >= dailyCap)        return { allowed: false, reason: 'trial_cap_daily' };
  if (input.trialTotalMinutes >= totalCap)   return { allowed: false, reason: 'trial_cap_total' };
  if (input.concurrentCalls >= TRIAL_LIMITS.CONCURRENT_CALLS) return { allowed: false, reason: 'trial_cap_concurrent' };
  return { allowed: true };
}
```

- [ ] **Step 4: Run + pass + commit.**

```bash
git commit -m "feat(voice): trial-limits constants + pure cap evaluator"
```

---

## Task 10: Gate A (subscription status) at inbound webhook

**Files:**
- Discover and modify: `packages/api/src/voice/<inbound handler>` (see Step 1)
- Modify: `packages/api/src/monitoring/metrics.ts`
- Create: `packages/api/test/integration/voice/inbound-gate-a.integration.test.ts`

- [ ] **Step 1: Locate the inbound voice entry point**

Run: `grep -rn "TwiML\|<Response>\|incoming.*call\|twilio.*webhook\|/voice/inbound" packages/api/src/ | head -30`

Expected: find the route handler that returns TwiML for an incoming Twilio call. Likely in `packages/api/src/webhooks/routes.ts` or `packages/api/src/telephony/`. Record the file:line here in the plan comment when found.

- [ ] **Step 2: Add metrics counter**

```ts
// packages/api/src/monitoring/metrics.ts (add)
import { Counter } from 'prom-client';

export const voiceBlocksTotal = new Counter({
  name: 'voice_blocks_total',
  help: 'Inbound voice calls blocked by trial/billing gates',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});
```

- [ ] **Step 3: Write the integration test**

```ts
// packages/api/test/integration/voice/inbound-gate-a.integration.test.ts
describe('Voice inbound — Gate A', () => {
  it('returns voicemail TwiML when subscription_status is canceled', async () => {
    await pool.query(`UPDATE tenants SET subscription_status='canceled' WHERE id=$1`, [tenantId]);
    const res = await request(app).post('/webhooks/twilio/voice').send({ To: tenantPhone, From: '+15125551234' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).toContain('being set up');
    const ev = await pool.query(`SELECT * FROM audit_events WHERE tenant_id=$1 AND event_type='voice_blocked_no_billing'`, [tenantId]);
    expect(ev.rows.length).toBe(1);
  });
  it('routes to agent normally when subscription_status is trialing', async () => {
    await pool.query(`UPDATE tenants SET subscription_status='trialing' WHERE id=$1`, [tenantId]);
    const res = await request(app).post('/webhooks/twilio/voice').send({ To: tenantPhone, From: '+15125551234' });
    expect(res.text).not.toContain('being set up');
  });
});
```

- [ ] **Step 4: Run + fail.**

- [ ] **Step 5: Insert Gate A at the top of the inbound handler**

```ts
// packages/api/src/<inbound voice handler file>
import { voiceBlocksTotal } from '../monitoring/metrics';

// ... inside the handler, AFTER tenant lookup by To-number, BEFORE any AI routing
const sub = await pool.query(`SELECT subscription_status FROM tenants WHERE id=$1`, [tenantId]);
const status = sub.rows[0]?.subscription_status as string | null;
if (status !== 'trialing' && status !== 'active') {
  voiceBlocksTotal.inc({ reason: 'no_billing' });
  await auditRepo.create(createAuditEvent({
    tenantId, actorId: null, actorRole: 'system',
    eventType: 'voice_blocked_no_billing', entityType: 'voice_session', entityId: callSid,
    metadata: { from: req.body.From, subscriptionStatus: status },
  }));
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This number is being set up. Please call back later.</Say>
  <Hangup/>
</Response>`);
  return;
}
```

- [ ] **Step 6: Run + pass + commit.**

```bash
git commit -m "feat(voice): Gate A — block inbound when subscription not trialing/active"
```

---

## Task 11: Gate B (cap check) at inbound webhook

**Files:**
- Modify: same inbound handler from Task 10
- Create: `packages/api/src/voice/load-trial-usage.ts`
- Create: `packages/api/test/integration/voice/inbound-gate-b.integration.test.ts`

- [ ] **Step 1: Write the usage loader test**

```ts
// packages/api/src/voice/load-trial-usage.test.ts
describe('loadTrialUsage', () => {
  it('returns daily + total minutes from voice_sessions', async () => {
    await pool.query(`INSERT INTO voice_sessions (id, tenant_id, channel, started_at, ended_at) VALUES
      (gen_random_uuid(), $1, 'voice_inbound', now() - interval '10 minutes', now() - interval '5 minutes'),
      (gen_random_uuid(), $1, 'voice_inbound', now() - interval '3 days',   now() - interval '3 days' + interval '4 minutes')`,
      [tenantId]);
    const usage = await loadTrialUsage(pool, tenantId);
    expect(usage.dailyMinutes).toBe(5);  // first row only — today
    expect(usage.trialTotalMinutes).toBe(9); // both
    expect(usage.concurrentCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run + fail.**

- [ ] **Step 3: Implement loadTrialUsage**

```ts
// packages/api/src/voice/load-trial-usage.ts
import type { Pool } from 'pg';
export interface TrialUsage { dailyMinutes: number; trialTotalMinutes: number; concurrentCalls: number; }
export async function loadTrialUsage(pool: Pool, tenantId: string): Promise<TrialUsage> {
  const res = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN started_at::date = (now() at time zone 'UTC')::date
        THEN EXTRACT(EPOCH FROM (ended_at - started_at)) / 60 END), 0)::int AS daily_minutes,
      COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS total_minutes,
      COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS concurrent
    FROM voice_sessions
    WHERE tenant_id = $1 AND channel = 'voice_inbound'
  `, [tenantId]);
  const r = res.rows[0];
  return { dailyMinutes: r.daily_minutes, trialTotalMinutes: r.total_minutes, concurrentCalls: r.concurrent };
}
```

- [ ] **Step 4: Write Gate B integration test**

```ts
describe('Voice inbound — Gate B', () => {
  it('blocks with trial_cap_total when total minutes >= 100', async () => {
    await pool.query(`UPDATE tenants SET subscription_status='trialing' WHERE id=$1`, [tenantId]);
    // seed 100 minutes of past sessions
    await pool.query(`INSERT INTO voice_sessions (id, tenant_id, channel, started_at, ended_at) VALUES
      (gen_random_uuid(), $1, 'voice_inbound', now() - interval '101 minutes', now() - interval '1 minute')`, [tenantId]);
    const res = await request(app).post('/webhooks/twilio/voice').send({ To: tenantPhone, From: '+15125551234' });
    expect(res.text).toContain('<Hangup');
    const ev = await pool.query(`SELECT * FROM audit_events WHERE tenant_id=$1 AND event_type='voice_blocked_trial_cap'`, [tenantId]);
    expect(ev.rows.length).toBe(1);
  });
});
```

- [ ] **Step 5: Insert Gate B (after Gate A) in the inbound handler**

```ts
import { evaluateTrialCap } from '../voice/trial-limits';
import { loadTrialUsage } from '../voice/load-trial-usage';

// AFTER Gate A passes:
const usage = await loadTrialUsage(pool, tenantId);
const gate = evaluateTrialCap({
  status: status as any,
  dailyMinutes: usage.dailyMinutes,
  trialTotalMinutes: usage.trialTotalMinutes,
  concurrentCalls: usage.concurrentCalls,
});
if (!gate.allowed) {
  voiceBlocksTotal.inc({ reason: gate.reason! });
  await auditRepo.create(createAuditEvent({
    tenantId, actorId: null, actorRole: 'system',
    eventType: 'voice_blocked_trial_cap', entityType: 'voice_session', entityId: callSid,
    metadata: { reason: gate.reason, usage },
  }));
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This number is being set up. Please call back later.</Say><Hangup/></Response>`);
  return;
}
```

- [ ] **Step 6: Run + pass + commit.**

```bash
git commit -m "feat(voice): Gate B — trial usage caps at inbound webhook"
```

---

## Task 12: Gate C (outbound allowlist constant)

The voice agent currently has no outbound capability. Gate C ships as a guardrail constant + checker that any future outbound path MUST go through.

**Files:**
- Create: `packages/api/src/voice/outbound-allowlist.ts`
- Create: `packages/api/src/voice/outbound-allowlist.test.ts`

- [ ] **Step 1: Test the allowlist checker**

```ts
import { isOutboundAllowed } from './outbound-allowlist';
describe('isOutboundAllowed', () => {
  it('allows US numbers', () => { expect(isOutboundAllowed('+15125551234').allowed).toBe(true); });
  it('allows Canadian numbers', () => { expect(isOutboundAllowed('+14165551234').allowed).toBe(true); });
  it('blocks non-NANP', () => {
    expect(isOutboundAllowed('+447911123456').allowed).toBe(false);
    expect(isOutboundAllowed('+819011234567').allowed).toBe(false);
  });
  it('blocks 900 and 976 NPAs', () => {
    expect(isOutboundAllowed('+19005551234').reason).toBe('premium_npa');
    expect(isOutboundAllowed('+19765551234').reason).toBe('premium_npa');
  });
  it('rejects malformed numbers', () => {
    expect(isOutboundAllowed('not a number').allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// packages/api/src/voice/outbound-allowlist.ts
const PREMIUM_NPAS = new Set(['900', '976']);
export interface OutboundCheck { allowed: boolean; reason?: 'non_nanp' | 'premium_npa' | 'malformed'; }

export function isOutboundAllowed(e164: string): OutboundCheck {
  if (!/^\+1\d{10}$/.test(e164)) {
    if (!/^\+\d{6,15}$/.test(e164)) return { allowed: false, reason: 'malformed' };
    return { allowed: false, reason: 'non_nanp' };
  }
  const npa = e164.slice(2, 5);
  if (PREMIUM_NPAS.has(npa)) return { allowed: false, reason: 'premium_npa' };
  return { allowed: true };
}
```

- [ ] **Step 3: Run + pass + commit.**

```bash
git commit -m "feat(voice): outbound allowlist guardrail (Gate C — passive)"
```

---

# Phase 4 — Frontend

## Task 13: OnboardingShell + sidebar + status hook + app-shell guard

**Files:**
- Create: `packages/web/src/hooks/useOnboardingStatus.ts`
- Create: `packages/web/src/components/onboarding/OnboardingShell.tsx`
- Create: `packages/web/src/components/onboarding/Sidebar.tsx`
- Modify: `packages/web/src/routes.ts`
- Modify: `packages/web/src/components/ProtectedRoute.tsx` (or equivalent shell file — discover in Step 1)
- Create: `packages/web/src/hooks/useOnboardingStatus.test.tsx`

- [ ] **Step 1: Locate the auth/shell wrapper that wraps `/`**

Run: `grep -n "ProtectedRoute\|isSignedIn\|RequireAuth" packages/web/src/routes.ts packages/web/src/components/ -r | head -10`

Expected: identify the component that gates authed routes; that's where the new `isComplete` guard goes.

- [ ] **Step 2: Test the hook (React Testing Library)**

```tsx
// packages/web/src/hooks/useOnboardingStatus.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useOnboardingStatus } from './useOnboardingStatus';

global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    steps: [
      { id: 'signup', status: 'done' }, { id: 'identity', status: 'current' },
      { id: 'pack', status: 'pending' }, { id: 'phone', status: 'pending' },
      { id: 'billing', status: 'pending' }, { id: 'test_call', status: 'pending' },
    ],
    currentStep: 'identity', isComplete: false,
  }),
});

describe('useOnboardingStatus', () => {
  it('fetches status and exposes currentStep', async () => {
    const { result } = renderHook(() => useOnboardingStatus());
    await waitFor(() => expect(result.current.data?.currentStep).toBe('identity'));
    expect(result.current.data?.isComplete).toBe(false);
  });
});
```

- [ ] **Step 3: Run + fail.**

- [ ] **Step 4: Implement the hook**

```tsx
// packages/web/src/hooks/useOnboardingStatus.ts
import { useEffect, useState, useCallback } from 'react';
import type { OnboardingStatusResponse } from '@serviceos/shared/contracts/onboarding';

export function useOnboardingStatus(pollIntervalMs = 3000) {
  const [data, setData] = useState<OnboardingStatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/status', { credentials: 'include' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) { setError(e as Error); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, pollIntervalMs);
    return () => clearInterval(id);
  }, [refetch, pollIntervalMs]);

  return { data, error, loading, refetch };
}
```

- [ ] **Step 5: Implement Sidebar component**

```tsx
// packages/web/src/components/onboarding/Sidebar.tsx
import type { OnboardingStatusResponse, OnboardingStepId } from '@serviceos/shared/contracts/onboarding';

const STEP_LABELS: Record<OnboardingStepId, string> = {
  signup: 'Sign up', identity: 'Business identity', pack: 'Pick your trade',
  phone: 'Phone number', billing: 'Start trial', test_call: 'Test call',
};

const ICON: Record<string, string> = { done: '✓', current: '→', pending: '○', error: '⚠', skipped: '✓' };

export function Sidebar({ status, onSelect }: { status: OnboardingStatusResponse; onSelect: (id: OnboardingStepId) => void }) {
  return (
    <nav className="w-72 border-r border-zinc-200 bg-zinc-50 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-3">Setup</div>
      <ul className="space-y-1">
        {status.steps.map((s) => {
          const isCurrent = s.id === status.currentStep;
          const cls = isCurrent ? 'bg-blue-50 text-blue-700 font-semibold' : s.status === 'done' || s.status === 'skipped' ? 'text-emerald-700' : s.status === 'error' ? 'text-red-700' : 'text-zinc-400';
          return (
            <li key={s.id}>
              <button onClick={() => onSelect(s.id)} className={`w-full text-left px-2 py-1.5 rounded text-sm ${cls}`}>
                <span className="mr-2">{ICON[s.status] ?? '○'}</span>{STEP_LABELS[s.id]}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 pt-3 border-t border-zinc-200 text-xs text-zinc-500">
        {status.steps.filter(s => s.status === 'done' || s.status === 'skipped').length} of 6 · keep going
      </div>
    </nav>
  );
}
```

- [ ] **Step 6: Implement OnboardingShell**

```tsx
// packages/web/src/components/onboarding/OnboardingShell.tsx
import { useState } from 'react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import { Sidebar } from './Sidebar';
import { IdentityStep } from './steps/IdentityStep';
import { PackStep } from './steps/PackStep';
import { PhoneStep } from './steps/PhoneStep';
import { BillingStep } from './steps/BillingStep';
import { TestCallStep } from './steps/TestCallStep';
import type { OnboardingStepId } from '@serviceos/shared/contracts/onboarding';

export function OnboardingShell() {
  const { data, refetch, loading } = useOnboardingStatus();
  const [override, setOverride] = useState<OnboardingStepId | null>(null);
  if (loading || !data) return <div className="p-8 text-zinc-500">Loading…</div>;
  const activeId = override ?? data.currentStep ?? 'test_call';
  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar status={data} onSelect={setOverride} />
      <main className="flex-1 p-8 max-w-3xl">
        {activeId === 'identity'  && <IdentityStep onSaved={refetch} />}
        {activeId === 'pack'      && <PackStep onSaved={refetch} />}
        {activeId === 'phone'     && <PhoneStep status={data} onAdvance={() => setOverride('billing')} />}
        {activeId === 'billing'   && <BillingStep />}
        {activeId === 'test_call' && <TestCallStep status={data} onSkipped={refetch} />}
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Wire the route + guard**

```tsx
// packages/web/src/routes.ts (replace existing /onboarding route)
import { OnboardingShell } from './components/onboarding/OnboardingShell';
const FLAG_V2 = import.meta.env.VITE_ONBOARDING_V2_ENABLED === 'true';
// ...
{ path: '/onboarding', Component: FLAG_V2 ? OnboardingShell : OnboardingPage },
```

```tsx
// packages/web/src/components/ProtectedRoute.tsx (or shell file)
// AFTER existing auth check, BEFORE rendering children:
import { useOnboardingStatus } from '../hooks/useOnboardingStatus';
import { Navigate, useLocation } from 'react-router-dom';
// ...
const { data } = useOnboardingStatus(30_000); // slow poll on the shell
const loc = useLocation();
if (data && !data.isComplete && !loc.pathname.startsWith('/onboarding')) {
  return <Navigate to="/onboarding" replace />;
}
```

- [ ] **Step 8: Run + pass + commit.**

```bash
git add packages/web/src/hooks/useOnboardingStatus.* packages/web/src/components/onboarding/OnboardingShell.tsx packages/web/src/components/onboarding/Sidebar.tsx packages/web/src/routes.ts packages/web/src/components/ProtectedRoute.tsx
git commit -m "feat(onboarding/web): shell + sidebar + status hook + app-shell guard"
```

---

## Task 14: Step 2 — Business identity form

**File:** Create `packages/web/src/components/onboarding/steps/IdentityStep.tsx`

- [ ] **Step 1: Test (RTL) — fills fields, submits, verifies fetch call.**

```tsx
// IdentityStep.test.tsx
it('PUTs /api/onboarding/identity with form values', async () => {
  const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  const onSaved = vi.fn();
  render(<IdentityStep onSaved={onSaved} />);
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Acme HVAC' } });
  fireEvent.change(screen.getByLabelText('Hourly rate (USD)'), { target: { value: '125' } });
  // ... toggle Mon/Fri open hours via UI controls
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/onboarding/identity', expect.objectContaining({ method: 'PUT' })));
  expect(onSaved).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement.**

```tsx
// packages/web/src/components/onboarding/steps/IdentityStep.tsx
import { useState, FormEvent } from 'react';

const DAYS = ['mon','tue','wed','thu','fri','sat','sun'] as const;
type Day = typeof DAYS[number];
interface DayHours { open: string; close: string }
type Hours = Partial<Record<Day, DayHours | null>>;

export function IdentityStep({ onSaved }: { onSaved: () => void }) {
  const [businessName, setBusinessName] = useState('');
  const [serviceAreaText, setServiceAreaText] = useState('');
  const [serviceAreaRadius, setServiceAreaRadius] = useState<number>(25);
  const [jobBufferMinutes, setJobBufferMinutes] = useState<number>(30);
  const [hourlyRateDollars, setHourlyRateDollars] = useState<number>(125);
  const [hours, setHours] = useState<Hours>({
    mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' },
    wed: { open: '08:00', close: '17:00' }, thu: { open: '08:00', close: '17:00' },
    fri: { open: '08:00', close: '17:00' }, sat: null, sun: null,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true); setErrors([]);
    const res = await fetch('/api/onboarding/identity', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName, serviceAreaText: serviceAreaText || undefined,
        serviceAreaRadius, businessHours: hours,
        jobBufferMinutes, hourlyRateCents: Math.round(hourlyRateDollars * 100),
      }),
    });
    setSubmitting(false);
    if (!res.ok) { const body = await res.json(); setErrors((body.issues ?? []).map((i: any) => i.message)); return; }
    onSaved();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-bold">Tell us about your business</h1>
      <label className="block">
        <span className="text-sm font-medium">Business name</span>
        <input value={businessName} onChange={e => setBusinessName(e.target.value)}
               className="mt-1 w-full border rounded px-3 py-2" required />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Service area</span>
        <div className="flex gap-2 mt-1">
          <input value={serviceAreaText} onChange={e => setServiceAreaText(e.target.value)}
                 placeholder="Austin, TX" className="flex-1 border rounded px-3 py-2" />
          <input type="number" value={serviceAreaRadius} onChange={e => setServiceAreaRadius(+e.target.value)}
                 className="w-24 border rounded px-3 py-2" /> <span className="self-center text-sm">mi</span>
        </div>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Business hours</legend>
        {DAYS.map(d => (
          <div key={d} className="flex items-center gap-3">
            <label className="w-24 capitalize"><input type="checkbox" checked={!!hours[d]}
              onChange={e => setHours({ ...hours, [d]: e.target.checked ? { open: '08:00', close: '17:00' } : null })} /> {d}</label>
            {hours[d] && (<>
              <input type="time" value={hours[d]!.open}
                onChange={e => setHours({ ...hours, [d]: { ...hours[d]!, open: e.target.value }})} />
              <input type="time" value={hours[d]!.close}
                onChange={e => setHours({ ...hours, [d]: { ...hours[d]!, close: e.target.value }})} />
            </>)}
          </div>
        ))}
      </fieldset>
      <label className="block">
        <span className="text-sm font-medium">Job buffer (minutes between jobs)</span>
        <input type="number" value={jobBufferMinutes} onChange={e => setJobBufferMinutes(+e.target.value)}
               className="mt-1 w-32 border rounded px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Hourly rate (USD)</span>
        <input type="number" value={hourlyRateDollars} onChange={e => setHourlyRateDollars(+e.target.value)}
               className="mt-1 w-32 border rounded px-3 py-2" />
      </label>
      {errors.length > 0 && (
        <ul className="text-red-600 text-sm space-y-1">{errors.map((m, i) => <li key={i}>{m}</li>)}</ul>
      )}
      <button type="submit" disabled={submitting}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">Save and continue</button>
    </form>
  );
}
```

- [ ] **Step 3: Run + pass + commit.**

```bash
git commit -m "feat(onboarding/web): IdentityStep form"
```

---

## Task 15: Step 3 — Pack picker

**File:** Create `packages/web/src/components/onboarding/steps/PackStep.tsx`

- [ ] **Step 1: Test.** Click HVAC card → POST `/api/onboarding/pack` with `{ packId: 'hvac' }` → `onSaved` called.

```tsx
it('activates HVAC on click', async () => {
  const fm = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  const onSaved = vi.fn();
  render(<PackStep onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: /hvac/i }));
  await waitFor(() => expect(fm).toHaveBeenCalledWith('/api/onboarding/pack', expect.objectContaining({ body: JSON.stringify({ packId: 'hvac' }) })));
  expect(onSaved).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement.**

```tsx
// packages/web/src/components/onboarding/steps/PackStep.tsx
import { useState } from 'react';
import type { PackPickInput } from '@serviceos/shared/contracts/onboarding';

const PACKS: Array<{ id: PackPickInput['packId']; name: string; blurb: string; stats: string }> = [
  { id: 'hvac',     name: 'HVAC',     blurb: 'Heating, cooling, ventilation.', stats: '12 job types · 40 line items · 18 message templates' },
  { id: 'plumbing', name: 'Plumbing', blurb: 'Repairs, installs, leaks, drains.', stats: '14 job types · 36 line items · 16 message templates' },
];

export function PackStep({ onSaved }: { onSaved: () => void }) {
  const [pending, setPending] = useState<PackPickInput['packId'] | null>(null);
  async function pick(packId: PackPickInput['packId']) {
    setPending(packId);
    const res = await fetch('/api/onboarding/pack', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId }),
    });
    setPending(null);
    if (res.ok) onSaved();
  }
  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Pick your trade</h1>
      <p className="text-zinc-600">We'll set up job types, pricing, and message templates for you. You can add another trade later.</p>
      <div className="grid grid-cols-2 gap-4">
        {PACKS.map(p => (
          <button key={p.id} disabled={pending !== null}
            onClick={() => pick(p.id)}
            className="text-left border rounded-lg p-5 hover:border-blue-500 disabled:opacity-50">
            <div className="text-lg font-semibold">{p.name}</div>
            <div className="text-sm text-zinc-600 mt-1">{p.blurb}</div>
            <div className="text-xs text-zinc-500 mt-3">{p.stats}</div>
            {pending === p.id && <div className="text-xs text-blue-600 mt-3">Activating…</div>}
          </button>
        ))}
      </div>
    </div>
  );
}
```

A "Browse what we set up" expansion is out of scope here — defer to a follow-up polish PR.

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(onboarding/web): PackStep picker for HVAC/Plumbing"
```

---

## Task 16: Step 4 — Phone provisioning UI

**File:** Create `packages/web/src/components/onboarding/steps/PhoneStep.tsx`

- [ ] **Step 1: Test.** Renders spinner when `twilioStatus='provisioning'`; renders number + Continue when `'full_readiness'`; renders error + Retry when `'failed'`.

- [ ] **Step 2: Implement.** Reads `twilio_status` indirectly via `useOnboardingStatus` (already polling at 3s in the shell). Three sub-renderings keyed on the status. The "Forward your existing business line" section is a Radix Collapsible with carrier tabs (Verizon `*72`, AT&T `*72`, T-Mobile `*72`, "Other" → "ask your carrier").

  The full provisioned phone number comes from `phone` step's `metadata.phoneNumber` (the schema already supports `metadata`, added in Task 2). Extend `OnboardingFacts` to include the phone number, attach it in `deriveOnboardingStatus` when `twilioStatus === 'full_readiness'`, and add a unit test for the metadata attachment to `derive-status.test.ts`.

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(onboarding/web): PhoneStep with status polling + forwarding tips"
```

---

## Task 17: Step 5 + Step 6 + "You're live"

**Files:**
- Create: `packages/web/src/components/onboarding/steps/BillingStep.tsx`
- Create: `packages/web/src/components/onboarding/steps/TestCallStep.tsx`

- [ ] **Step 1: BillingStep test + implementation.**

```tsx
// packages/web/src/components/onboarding/steps/BillingStep.tsx
import { useState } from 'react';

export function BillingStep() {
  const [pending, setPending] = useState(false);
  async function start() {
    setPending(true);
    const res = await fetch('/api/onboarding/billing/checkout-session', {
      method: 'POST', credentials: 'include',
    });
    const body = await res.json();
    if (body.url) window.location.href = body.url;
    setPending(false);
  }
  return (
    <div className="space-y-4 max-w-md">
      <h1 className="text-2xl font-bold">Start your 14-day free trial</h1>
      <p className="text-zinc-600">No charge for 14 days. You can cancel anytime from settings.</p>
      <ul className="text-sm text-zinc-600 list-disc pl-5 space-y-1">
        <li>Card required to start the trial</li>
        <li>You'll be charged on day 15 if you don't cancel</li>
        <li>Caps lift once your subscription is active</li>
      </ul>
      <button onClick={start} disabled={pending}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
        {pending ? 'Opening checkout…' : 'Start 14-day free trial'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: TestCallStep test + implementation.**

```tsx
// packages/web/src/components/onboarding/steps/TestCallStep.tsx
import { useNavigate } from 'react-router-dom';
import type { OnboardingStatusResponse } from '@serviceos/shared/contracts/onboarding';

export function TestCallStep({ status, onSkipped }: { status: OnboardingStatusResponse; onSkipped: () => void }) {
  const navigate = useNavigate();
  const step = status.steps.find(s => s.id === 'test_call')!;
  const phoneStep = status.steps.find(s => s.id === 'phone');
  const phoneNumber = (phoneStep?.metadata as { phoneNumber?: string } | undefined)?.phoneNumber ?? '';

  async function skip() {
    await fetch('/api/onboarding/test-call/skip', { method: 'POST', credentials: 'include' });
    onSkipped();
  }

  if (step.status === 'done' || step.status === 'skipped') {
    return (
      <div className="text-center space-y-6 py-16">
        <div className="text-6xl">🎉</div>
        <h1 className="text-3xl font-bold">You're live</h1>
        <p className="text-zinc-600">Your AI agent is answering calls.</p>
        <button onClick={() => navigate('/')}
                className="px-6 py-3 bg-blue-600 text-white rounded text-lg">Go to dashboard</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-md">
      <h1 className="text-2xl font-bold">Make a test call</h1>
      <p className="text-zinc-600">Call this number from your phone right now. We'll detect it and finish setup.</p>
      <div className="border-2 border-blue-500 rounded-lg p-6 text-center">
        <div className="text-3xl font-mono">{phoneNumber || '(provisioning…)'}</div>
        <button onClick={() => navigator.clipboard.writeText(phoneNumber)}
                className="mt-2 text-sm text-blue-600">Copy</button>
      </div>
      <div className="text-sm text-zinc-500">Waiting for your call…</div>
      <button onClick={skip} className="text-sm text-zinc-500 underline">Skip — I'll test later</button>
    </div>
  );
}
```

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(onboarding/web): BillingStep + TestCallStep + You're live screen"
```

---

# Phase 5 — Conversion + Optional

## Task 18: Upgrade nudge banner + email

**Files:**
- Create: `packages/api/src/voice/check-upgrade-nudge.ts` (called after each call ends)
- Create: `packages/api/src/voice/check-upgrade-nudge.test.ts`
- Create: `packages/web/src/components/UpgradeNudgeBanner.tsx`
- Modify: the call-end handler (wherever `voice_sessions.ended_at` is set) to call `checkAndFireUpgradeNudge(pool, tenantId)`.

- [ ] **Step 1: Test the nudge trigger**

```ts
describe('checkAndFireUpgradeNudge', () => {
  it('does nothing under 30 trial minutes', async () => {
    const sendEmail = vi.fn();
    await checkAndFireUpgradeNudge({ pool, tenantId, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('fires email + records prompt_shown_at when crossing 30 minutes', async () => {
    // seed 31 trialing minutes, status=trialing
    const sendEmail = vi.fn().mockResolvedValue({ delivered: true });
    await checkAndFireUpgradeNudge({ pool, tenantId, sendEmail });
    expect(sendEmail).toHaveBeenCalledOnce();
    const row = await pool.query(`SELECT onboarding_upgrade_prompt_shown_at FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
    expect(row.rows[0].onboarding_upgrade_prompt_shown_at).toBeTruthy();
  });
  it('is idempotent — second call does nothing', async () => {
    // first call (as above)
    const sendEmail = vi.fn();
    await checkAndFireUpgradeNudge({ pool, tenantId, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// packages/api/src/voice/check-upgrade-nudge.ts
import type { Pool } from 'pg';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';

const UPGRADE_THRESHOLD_MINUTES = 30;

export async function checkAndFireUpgradeNudge(deps: { pool: Pool; tenantId: string; sendEmail: MessageDeliveryProvider['sendEmail']; ownerEmail?: string; }) {
  const { pool, tenantId } = deps;
  const t = await pool.query(`SELECT subscription_status FROM tenants WHERE id=$1`, [tenantId]);
  if (t.rows[0]?.subscription_status !== 'trialing') return;
  const s = await pool.query(`SELECT onboarding_upgrade_prompt_shown_at FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
  if (s.rows[0]?.onboarding_upgrade_prompt_shown_at) return;
  const usage = await pool.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS mins
       FROM voice_sessions WHERE tenant_id=$1 AND channel='voice_inbound' AND ended_at IS NOT NULL`,
    [tenantId]
  );
  if (usage.rows[0].mins < UPGRADE_THRESHOLD_MINUTES) return;
  await pool.query(`UPDATE tenant_settings SET onboarding_upgrade_prompt_shown_at = now() WHERE tenant_id=$1`, [tenantId]);
  if (deps.ownerEmail) {
    await deps.sendEmail({
      to: deps.ownerEmail,
      subject: "Your AI agent is earning — lock in your subscription",
      text: `You've used 30 minutes of trial voice. Convert now to remove caps: ${process.env.WEB_URL}/onboarding?action=upgrade-now`,
    });
  }
}
```

- [ ] **Step 3: Hook into the call-end handler.**

```ts
// wherever ended_at is set on a voice_sessions row
await checkAndFireUpgradeNudge({ pool, tenantId, sendEmail: deliveryProvider.sendEmail.bind(deliveryProvider), ownerEmail: tenant.ownerEmail });
```

- [ ] **Step 4: Banner component**

```tsx
// packages/web/src/components/UpgradeNudgeBanner.tsx
import { useOnboardingStatus } from '../hooks/useOnboardingStatus';
// Show banner when: subscription is trialing AND tenant_settings.onboarding_upgrade_prompt_shown_at is set within last 7 days
// (Expose `upgradePromptShownAt` on the status payload as a top-level optional field.)
export function UpgradeNudgeBanner() {
  // ... renders an action bar with "End trial and subscribe now" → POST /api/billing/end-trial-now
}
```

- [ ] **Step 5: Run + pass + commit.**

```bash
git commit -m "feat(onboarding): 30-minute upgrade nudge — email + banner"
```

---

## Task 19: Optional steps relocation

**File:** Create `packages/web/src/components/onboarding/steps/OptionalSteps.tsx` and integrate into `OnboardingShell.tsx`.

- [ ] **Step 1: Add an "Optional" section to the sidebar** that only becomes interactive when `isComplete === true`.

- [ ] **Step 2: Extract the terminology + automation-rules forms from the existing `OnboardingPage.tsx`** into two components (`TerminologyStep`, `AutomationRulesStep`) under `OptionalSteps.tsx`. They each call the same backend endpoints that the old wizard used (no new endpoints).

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(onboarding/web): relocate terminology + automation steps as optional"
```

---

# Phase 6 — E2E + Rollout

## Task 20: E2E spec

**File:** Create `e2e/onboarding-v2.spec.ts`

- [ ] **Step 1: Add the full journey test**

```ts
// e2e/onboarding-v2.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFreshTenant, seedTwilioReady, mockStripeCheckoutSuccess, seedInboundCall } from './fixtures/onboarding-helpers';

test('§10 — full onboarding flow', async ({ page }) => {
  await signUpFreshTenant(page);
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByText('Business identity')).toBeVisible();

  // Identity
  await page.getByLabel('Business name').fill('Acme HVAC');
  await page.getByLabel('Hourly rate (USD)').fill('125');
  // ... fill hours
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText('Pick your trade')).toBeVisible();

  // Pack
  await page.getByRole('button', { name: /hvac/i }).click();
  await expect(page.getByText('Phone number')).toBeVisible();

  // Phone — seed Twilio ready via API helper (E2E test mode)
  await seedTwilioReady(page);
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByText('Start trial')).toBeVisible();

  // Billing — mock the Stripe success webhook
  await mockStripeCheckoutSuccess(page);
  await expect(page.getByText('Test call')).toBeVisible();

  // Test call — seed an inbound voice_session
  await seedInboundCall(page);
  await expect(page.getByText("You're live")).toBeVisible();

  // Go to dashboard
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await expect(page).toHaveURL('/');
});

test('§10 — resumability: reload mid-flow returns to current step', async ({ page }) => {
  await signUpFreshTenant(page);
  await page.getByLabel('Business name').fill('Acme');
  await page.getByLabel('Hourly rate (USD)').fill('125');
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /hvac/i }).click();
  await page.reload();
  await expect(page.getByText('Phone number')).toBeVisible();
});

test('§10 — skip test call', async ({ page }) => {
  // ... seed everything up through trial active
  await page.getByRole('link', { name: /skip.*test later/i }).click();
  await expect(page.getByText("You're live")).toBeVisible();
});
```

- [ ] **Step 2: Add helpers** in `e2e/fixtures/onboarding-helpers.ts` using direct DB writes against the test DB (testcontainers Postgres, same shape as integration tests). The helpers mutate `tenant_integrations`, insert `voice_sessions` rows, and post Stripe webhook fixtures to `/webhooks/stripe`.

- [ ] **Step 3: Run E2E**

```bash
ONBOARDING_V2_ENABLED=true VITE_ONBOARDING_V2_ENABLED=true npm run e2e -- onboarding-v2
```

Expected: 3 tests PASS.

- [ ] **Step 4: Commit.**

```bash
git commit -m "test(onboarding): E2E coverage for full flow + resumability + skip"
```

---

## Task 21: Feature flag wiring + rollout

**Files:**
- Modify: `packages/api/src/shared/config.ts`
- Modify: `.env.example`
- Modify: `packages/web/.env.example`

- [ ] **Step 1: Add flags to config**

```ts
// packages/api/src/shared/config.ts (add to Zod schema)
ONBOARDING_V2_ENABLED:               z.enum(['true', 'false']).default('false'),
TRIAL_VOICE_MINUTES_DAILY_OVERRIDE:  z.string().optional(),
TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE:  z.string().optional(),
STRIPE_PRICE_ID:                     z.string().min(1),
WEB_URL:                             z.string().url(),
```

- [ ] **Step 2: Document env vars**

```bash
# .env.example (add)
ONBOARDING_V2_ENABLED=false
TRIAL_VOICE_MINUTES_DAILY_OVERRIDE=
TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE=
STRIPE_PRICE_ID=
WEB_URL=http://localhost:5173
```

```bash
# packages/web/.env.example (add)
VITE_ONBOARDING_V2_ENABLED=false
```

- [ ] **Step 3: Verify production build is green**

Run: `npm run typecheck`
Expected: clean exit, no errors.

- [ ] **Step 4: Apply migration to dev**

Run: `npm run migrate:apply` (against dev DB)
Expected: migration 073 listed as applied.

- [ ] **Step 5: Smoke checklist (manual, in dev with flag flipped on)**

- Fresh Clerk signup → redirected to `/onboarding`, sidebar shows identity as current.
- Submit identity → sidebar advances to pack.
- Activate HVAC → sidebar advances to phone.
- Wait ≤60s for Twilio provisioning → phone shows the number.
- Click "Start 14-day free trial" → Stripe Checkout opens; complete with test card `4242 4242 4242 4242` → returns to `/onboarding?billing=ok` → step 5 ✓.
- Call the provisioned number from a real phone → "You're live" screen appears within ~5s.
- Reload at any step → returns to that step.
- Open `/` directly while incomplete → redirected to `/onboarding`.
- With `subscription_status='canceled'` (set via SQL), call the number → hear voicemail TwiML; `voice_blocks_total{reason="no_billing"}` increments.

- [ ] **Step 6: Commit + open PR**

```bash
git add packages/api/src/shared/config.ts .env.example packages/web/.env.example
git commit -m "feat(onboarding): wire ONBOARDING_V2_ENABLED flag + env vars"
```

PR title: `feat(onboarding): §10 self-serve setup — resumable checklist + trial gates`

PR body should reference the spec and call out:

- Flag-gated rollout sequence (dev → staging → prod → 7-day soak → delete old wizard).
- Migration 073 is additive (deployed unconditionally).
- Old `OnboardingPage.tsx` and `POST /api/onboarding/configure` remain functional with flag off.
- Test card for Stripe smoke: `4242 4242 4242 4242` + any future date.
- Caps tunable via `TRIAL_VOICE_MINUTES_DAILY_OVERRIDE` / `TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE` env vars for staging/QA.

- [ ] **Step 7: Schedule old-wizard removal as a follow-up issue.**

After 7 days of clean prod traffic with the flag on, open a follow-up PR that deletes `packages/web/src/components/onboarding/OnboardingPage.tsx` (the 924-line old wizard) and the legacy `POST /api/onboarding/configure` route handler.

---

# Spec coverage map

| Spec section | Covered by task |
|---|---|
| Resumability derivation rules | Task 3 |
| Schema migration | Task 1 |
| `GET /api/onboarding/status` | Task 4 |
| `PUT /api/onboarding/identity` | Task 5 |
| `POST /api/onboarding/pack` | Task 6 |
| `POST /api/onboarding/billing/checkout-session` | Task 8 |
| `POST /api/onboarding/test-call/skip` | Task 7 |
| `POST /api/billing/end-trial-now` | Task 8 |
| Step-by-step UX (steps 2–6) | Tasks 14–17 |
| Sidebar layout + auth guard | Task 13 |
| Optional steps (terminology, automation) | Task 19 |
| Gate A — subscription status | Task 10 |
| Gate B — trial usage caps | Task 11 |
| Gate C — outbound allowlist | Task 12 |
| 30-minute upgrade nudge | Task 18 |
| Audit events + Prom counters | Tasks 5, 6, 7, 10, 11 (each task adds its own events/counters) |
| Unit + integration tests | Throughout (TDD on every task) |
| E2E coverage | Task 20 |
| Feature flag rollout | Task 21 |
