# "Time Given Back" Surface (§9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the product's north-star — hours the owner did not spend running the business — on the home screen, as a weekly headline ("6.5 hours given back ≈ $480 this week") computed from real, typed records, backed by a legible receipt, and driven by versioned, tunable time-credit constants.

**Architecture:** The countable "automated actions" already exist as first-class, typed, timestamped rows: every `Proposal` is — by D-004 — work the AI did that the owner approved with a tap, and every ended `VoiceSession` is a call the AI handled. A new versioned constants module (`time-credits.ts`) assigns a fixed number of minutes to each `ProposalType` and to a handled call. A **pure function** `computeTimeGivenBack(...)` sums the credits for executed proposals + ended calls inside a week window and converts to a dollar value via the tenant's hourly rate. A `TimeGivenBackReporter` composes the existing `ProposalRepository` + `VoiceSessionRepository` + `SettingsRepository` and runs the pure function — one implementation that works on both the Pg and in-memory boot paths because those repositories already abstract storage. A `GET /api/reports/time-given-back` endpoint hangs off the existing `createReportsRouter`. The home screen gets a self-contained `TimeGivenBackCard` at the top. The owner's hourly rate is added to `tenant_settings` (the field §10 onboarding will populate; §9 makes it exist and be settable).

**Tech Stack:** TypeScript, Node, Express. Tests: vitest + supertest. Persistence: PostgreSQL via the `schema.ts` keyed-migration object; in-memory repositories for tests. Web: React + Tailwind, `useApiClient` fetch hook.

---

## Context the executing engineer needs

**This is a net-new feature surface (§9 is one of the two LARGE launch sections), but the event substrate already exists.** Nothing about "time given back" exists today — no credit constants, no aggregation, no widget. But the records it computes *from* are fully built.

**Why `proposals` + `voice_sessions` are the data source — and not the audit log.** The launch spec says "computed from real events." The cleanest, typed, unambiguous "real events" available are:
- The **`proposals` table.** Per founding decision D-004, "the AI never writes directly… every state change is a typed proposal a human approves." So a proposal in `executed` status is *exactly* "the AI did the work + the owner tapped once" — the definition of time given back. Each proposal carries its `proposalType` (a typed union) and `executedAt`.
- The **`voice_sessions` table.** An ended voice session is a call the AI handled end-to-end.

The `audit_events` table was considered and rejected as the primary source: `audit_events.eventType` is a free-form string, the same event type (`invoice.created`) fires for both AI-driven and owner-driven actions with no reliable discriminator, and the one central proposal-event helper (`logProposalEvent`) is currently unused — so `audit_events` cannot cleanly answer "was this automated?". `proposals` and `voice_sessions` answer it by construction.

**Scale assumption.** `ProposalRepository.findByTenant(tenantId)` and `VoiceSessionRepository.findByTenant(tenantId)` return *all* rows for a tenant (no built-in date filter). The weekly window is applied in the pure function. For a solo owner-operator over a launch timeframe this is a small set (hundreds, not millions of rows) — acceptable, and it keeps this plan free of new repository methods and new indexes. If volume ever warrants it, a `findByTenant(tenantId, { from, to })` overload is the natural follow-up; it is explicitly out of scope here.

**Time credits are a `Partial` map with a default — deliberately not exhaustive.** `PROPOSAL_TIME_CREDITS` is `Partial<Record<ProposalType, number>>`, not an exhaustive `Record`. The spec wants these "tunable constants, versioned, so the estimate can be recalibrated post-launch safely" — a compile-time forcing function fights that. A `ProposalType` with no explicit credit falls back to `DEFAULT_PROPOSAL_CREDIT_MINUTES`. This also keeps §9 independent of the §8 plan: §8 adds a `log_expense` proposal type — if §8 has landed, add a `log_expense` credit to the map; if not, the default covers it. Either order is fine.

**Hourly rate.** The spec says the owner's hourly rate is "captured in onboarding" (§10 — a separate, unbuilt plan). `tenant_settings` has **no** hourly-rate column today. This plan adds `hourlyRateCents` to `TenantSettings` + the `tenant_settings` table and makes it settable through the existing settings update route. The §10 onboarding plan will wire the onboarding form to populate it. Until it is set, the time-given-back headline shows hours only (no dollar value) — the pure function returns `dollarValueCents: null`.

**`createReportsRouter` is touched by two launch plans.** Both this plan (§9) and the Money Dashboard plan (§8) add a report to `createReportsRouter` in `packages/api/src/routes/reports.ts`. To keep them independent, **this plan converts `createReportsRouter` from a positional signature to an options-object signature.** Today it is `createReportsRouter(revenueBySourceRepo)`. After this plan it is `createReportsRouter({ revenueBySourceRepo, timeGivenBackReporter })`. If the §8 plan has already converted it to an options object, do **not** re-convert — just add the `timeGivenBackReporter` key to the existing `ReportsRouterDeps` type and the two call sites.

**Migration keys.** `packages/api/src/db/schema.ts` exports `const MIGRATIONS = { '...': '...' }`; `getMigrationSQL()` joins `Object.values(MIGRATIONS)` and re-runs the whole SQL on every boot, so every statement must be idempotent (`ADD COLUMN IF NOT EXISTS`, etc.). The highest key in the repo today is `094_add_held_appointment_fields`. The §6 plan claims `095_jobs_money_state`; the §8 plan claims `096_create_expenses`. **This plan claims `097_add_tenant_hourly_rate`.** If `097` is already taken when you execute, bump to the next free integer — keys must be unique; the value is idempotent regardless.

**Key existing code (exact shapes the tasks depend on):**

- `ProposalType` (`packages/api/src/proposals/proposal.ts:24`): a string-literal union — `'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'create_booking' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'issue_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'record_payment' | 'emergency_dispatch' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule'`. (If the §8 plan landed first, it also includes `'log_expense'`.)
- `Proposal` (`packages/api/src/proposals/proposal.ts:52`): `status: ProposalStatus`, `proposalType: ProposalType`, `executedAt?: Date`, `updatedAt: Date`, `createdAt: Date`, `tenantId: string`. `ProposalStatus` includes `'executed'`. `ProposalRepository` (line 320) has `findByTenant(tenantId): Promise<Proposal[]>` and `findByStatus(tenantId, status)`. `InMemoryProposalRepository` exists. `createProposal(input)` builds a `Proposal`.
- `VoiceSession` / `VoiceSessionRepository` (`packages/api/src/voice/voice-session.ts`): the repository has `findByTenant(tenantId, opts?): Promise<VoiceSessionRow[]>`; rows carry `tenantId: string` and `endedAt?: Date` (set when the call ends). There is an in-memory implementation. **Read this file at the start of Task 4** to confirm the exact `findByTenant` option name (an "ended only" filter exists) and the row type name — the reporter in Task 4 only needs `{ endedAt?: Date }` structurally.
- `TenantSettings` (`packages/api/src/settings/settings.ts:25`): the settings shape. It already carries optional, nullable numeric fields — `depositFixedCents?: number | null` is the exact precedent for the new `hourlyRateCents?: number | null` (same type shape, same null-means-unset semantics). `SettingsRepository` (line 176): `create / findByTenant / update / incrementEstimateNumber / incrementInvoiceNumber`. `InMemorySettingsRepository` (line 529) — its `update` does `{ ...settings, ...updates }`, so a new optional field round-trips with no in-memory change. The Pg implementation lives in `packages/api/src/settings/pg-settings.ts`; the settings update route lives in `packages/api/src/routes/settings.ts`.
- `createReportsRouter` (`packages/api/src/routes/reports.ts:12`): wired in `app.ts:1909-1912` (mounted at `/api/reports`). The route test `packages/api/test/routes/reports.route.test.ts` builds its own express app inline (`buildApp()`), with a fake-auth middleware injecting `{ userId, sessionId, tenantId, role: 'owner' }`.
- `RevenueBySourcePage` (`packages/web/src/components/reports/RevenueBySourcePage.tsx`) is the canonical report page — `useApiClient()` (`packages/web/src/lib/apiClient.ts:88`), `useState`, a fetch in `useEffect`, summary cards.
- `HomePage` (`packages/web/src/components/home/HomePage.tsx`): `export function HomePage()` at line 221. Its JSX `return (` is at line 268. The structure is: outer `<div className="h-full overflow-y-auto pb-20 md:pb-0">` → `<div className="max-w-6xl mx-auto">` → `{/* ── Header ── */}` block (`<div className="px-4 md:px-6 pt-5 pb-4 border-b border-slate-100">`, lines ~272-302, contains the greeting and a 3-stat pulse) → `{/* ── Two-column layout ── */}` `<div>` (line ~303). The time-given-back card goes **between the Header block's closing `</div>` and the `{/* ── Two-column layout ── */}` div** — first thing below the header, above today's jobs.
- Web routes are registered in `packages/web/src/routes.ts` (children array around line 167).

**Commands:**
- Run one API test file: from `packages/api`, `npm test -- <relative/path/to/test>`
- Full API test suite: from `packages/api`, `npm test`
- API production typecheck (the Railway build — mandatory before any commit): from repo root, `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- Web typecheck: from `packages/web`, `npx tsc --noEmit`

---

## File Structure

**Created:**
- `packages/api/src/reports/time-credits.ts` — `TIME_CREDIT_VERSION`, `PROPOSAL_TIME_CREDITS`, `DEFAULT_PROPOSAL_CREDIT_MINUTES`, `CALL_HANDLED_CREDIT_MINUTES`, `creditForProposalType`.
- `packages/api/src/reports/time-given-back.ts` — `TimeGivenBackSummary`, `TimeGivenBackInput`, `computeTimeGivenBack` (pure), `TimeGivenBackReporter` interface, `RepoBackedTimeGivenBackReporter`, `currentWeekWindow`.
- `packages/api/test/reports/time-credits.test.ts` — unit tests for the credit lookup.
- `packages/api/test/reports/time-given-back.test.ts` — unit tests for the pure function.
- `packages/api/test/reports/time-given-back-reporter.test.ts` — tests for the repo-backed reporter.
- `packages/api/test/routes/time-given-back.route.test.ts` — route-shape test.
- `packages/web/src/components/home/TimeGivenBackCard.tsx` — the home-screen widget.

**Modified:**
- `packages/api/src/settings/settings.ts` — add `hourlyRateCents?: number | null` to `TenantSettings`.
- `packages/api/src/settings/pg-settings.ts` — round-trip `hourly_rate_cents` in `mapRow` + the `update` field-map.
- `packages/api/src/routes/settings.ts` — accept `hourlyRateCents` in the settings update handler.
- `packages/api/src/db/schema.ts` — add the `097_add_tenant_hourly_rate` migration.
- `packages/api/src/routes/reports.ts` — convert `createReportsRouter` to an options object; add `GET /time-given-back`.
- `packages/api/src/app.ts` — construct the `RepoBackedTimeGivenBackReporter`; pass it into `createReportsRouter`.
- `packages/api/test/routes/reports.route.test.ts` — update `buildApp()` for the options-object signature.
- `packages/web/src/components/home/HomePage.tsx` — render `<TimeGivenBackCard />` below the header.

---

## Task 1: `hourlyRateCents` on tenant settings

**Files:**
- Modify: `packages/api/src/settings/settings.ts`
- Modify: `packages/api/src/settings/pg-settings.ts`
- Modify: `packages/api/src/routes/settings.ts`
- Modify: `packages/api/src/db/schema.ts`
- Test: `packages/api/test/settings/hourly-rate.test.ts` (create)

- [ ] **Step 1: Create the working branch**

```bash
git checkout main && git checkout -b feat/time-given-back-surface
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/settings/hourly-rate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
  };
}

describe('TenantSettings.hourlyRateCents', () => {
  it('round-trips through the in-memory repository update path', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings('t1'));

    const updated = await repo.update('t1', { hourlyRateCents: 15000 });
    expect(updated?.hourlyRateCents).toBe(15000);

    const fetched = await repo.findByTenant('t1');
    expect(fetched?.hourlyRateCents).toBe(15000);
  });

  it('defaults to undefined when never set', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings('t2'));
    const fetched = await repo.findByTenant('t2');
    expect(fetched?.hourlyRateCents).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/settings/hourly-rate.test.ts`
Expected: FAIL — TypeScript error: `hourlyRateCents` does not exist on `TenantSettings` (the `repo.update({ hourlyRateCents: 15000 })` call won't compile).

- [ ] **Step 4: Add the field to `TenantSettings`**

In `packages/api/src/settings/settings.ts`, add `hourlyRateCents` to the `TenantSettings` interface. Place it near the deposit fields (it has the same `number | null` shape as `depositFixedCents`):

```typescript
  /**
   * §9 — the owner's effective hourly rate, integer cents. Used by the
   * Time-Given-Back surface to convert saved hours into a dollar
   * figure. Null/undefined = not yet set (captured during §10
   * onboarding); until then the headline shows hours only.
   */
  hourlyRateCents?: number | null;
```

If `settings.ts` has a `CreateSettingsInput` type and/or a `validateSettingsInput` function, add `hourlyRateCents?: number | null` to that input type too, and — if other numeric fields are range-validated — add a guard: `if (input.hourlyRateCents != null && (!Number.isInteger(input.hourlyRateCents) || input.hourlyRateCents < 0)) errors.push('hourlyRateCents must be a non-negative integer');`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/settings/hourly-rate.test.ts`
Expected: PASS — `InMemorySettingsRepository.update` spreads `{ ...settings, ...updates }`, so the new optional field round-trips with no repo change.

- [ ] **Step 6: Thread the column through the Pg repository**

Open `packages/api/src/settings/pg-settings.ts`. Find how `depositFixedCents` (a `number | null` optional field) is handled and replicate it for `hourlyRateCents`:
- In the row-mapper (`mapRow` / `mapRowToSettings`): add `hourlyRateCents: row.hourly_rate_cents != null ? Number(row.hourly_rate_cents) : undefined,` alongside the `depositFixedCents` mapping.
- In the `update` field-map (the block that builds `SET` clauses from `updates`): add the `hourly_rate_cents` entry alongside `deposit_fixed_cents`, e.g. `if (updates.hourlyRateCents !== undefined) { setClauses.push(\`hourly_rate_cents = $${i++}\`); values.push(updates.hourlyRateCents); }`.
- If `create` writes an explicit column list, add `hourly_rate_cents` there too (it may be omitted on create and only set via `update` — match how `deposit_fixed_cents` is treated).

- [ ] **Step 7: Accept the field in the settings update route**

Open `packages/api/src/routes/settings.ts`. Find the update handler (`PUT` / `PATCH /api/settings`) and locate where it whitelists/validates the updatable fields (look for `defaultPaymentTermDays` or `depositFixedCents`). Add `hourlyRateCents` to that whitelist with the same validation the other numeric fields get — reject a non-integer or negative value with a 400. Follow the exact pattern already in the file; do not invent a new validation style.

- [ ] **Step 8: Add the `097_add_tenant_hourly_rate` migration**

In `packages/api/src/db/schema.ts`, add a new entry to the `MIGRATIONS` object after the highest existing key (bump the integer if `097` is taken):

```typescript
  '097_add_tenant_hourly_rate': `
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER;
  `,
```

- [ ] **Step 9: Typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/api/src/settings/settings.ts packages/api/src/settings/pg-settings.ts packages/api/src/routes/settings.ts packages/api/src/db/schema.ts packages/api/test/settings/hourly-rate.test.ts
git commit -m "feat(api): add hourlyRateCents to tenant settings"
```

---

## Task 2: Versioned time-credit constants

**Files:**
- Create: `packages/api/src/reports/time-credits.ts`
- Test: `packages/api/test/reports/time-credits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/reports/time-credits.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  TIME_CREDIT_VERSION,
  PROPOSAL_TIME_CREDITS,
  DEFAULT_PROPOSAL_CREDIT_MINUTES,
  CALL_HANDLED_CREDIT_MINUTES,
  creditForProposalType,
} from '../../src/reports/time-credits';

describe('time-credit constants', () => {
  it('has a non-empty version string', () => {
    expect(typeof TIME_CREDIT_VERSION).toBe('string');
    expect(TIME_CREDIT_VERSION.length).toBeGreaterThan(0);
  });

  it('returns an explicit credit for a mapped proposal type', () => {
    expect(creditForProposalType('draft_estimate')).toBe(
      PROPOSAL_TIME_CREDITS.draft_estimate,
    );
    expect(creditForProposalType('draft_estimate')).toBeGreaterThan(0);
  });

  it('returns the default credit for an unmapped proposal type', () => {
    // voice_clarification is explicitly mapped to 0 (not a real action);
    // a hypothetical unmapped type falls back to the default.
    expect(creditForProposalType('voice_clarification')).toBe(0);
    expect(creditForProposalType('create_customer')).toBeGreaterThan(0);
  });

  it('assigns a positive credit to a handled call', () => {
    expect(CALL_HANDLED_CREDIT_MINUTES).toBeGreaterThan(0);
  });

  it('every explicit credit is a non-negative integer', () => {
    for (const value of Object.values(PROPOSAL_TIME_CREDITS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isInteger(DEFAULT_PROPOSAL_CREDIT_MINUTES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/reports/time-credits.test.ts`
Expected: FAIL — `Cannot find module '../../src/reports/time-credits'`.

- [ ] **Step 3: Write the constants module**

Create `packages/api/src/reports/time-credits.ts`:

```typescript
import type { ProposalType } from '../proposals/proposal';

/**
 * §9 — versioned time-credit constants.
 *
 * Each automated action carries a small, fixed number of minutes the
 * owner did NOT spend doing it by hand. The numbers are deliberately
 * conservative — the dollar figure they drive has to stay credible.
 *
 * `PROPOSAL_TIME_CREDITS` is a Partial map, not an exhaustive Record:
 * the spec wants these "tunable, versioned, recalibrate-safe", and a
 * compile-time forcing function fights that. A ProposalType with no
 * explicit entry falls back to `DEFAULT_PROPOSAL_CREDIT_MINUTES`.
 *
 * Bump `TIME_CREDIT_VERSION` whenever a number changes so a stored or
 * displayed estimate can be traced to the calibration that produced it.
 */
export const TIME_CREDIT_VERSION = 'v1-2026-05';

/** Minutes credited per executed proposal, by type. */
export const PROPOSAL_TIME_CREDITS: Partial<Record<ProposalType, number>> = {
  create_customer: 3,
  update_customer: 2,
  create_job: 4,
  create_appointment: 4,
  create_booking: 5,
  draft_estimate: 12,
  update_estimate: 4,
  draft_invoice: 8,
  update_invoice: 3,
  issue_invoice: 3,
  reassign_appointment: 2,
  reschedule_appointment: 5,
  cancel_appointment: 3,
  // Not a real mutation — a clarifying prompt. Explicitly zero.
  voice_clarification: 0,
  add_note: 1,
  send_invoice: 3,
  record_payment: 3,
  emergency_dispatch: 5,
  onboarding_tenant_settings: 2,
  onboarding_service_category: 2,
  onboarding_estimate_template: 2,
  onboarding_team_member: 2,
  onboarding_schedule: 2,
  // If the §8 plan has landed, `log_expense` exists in ProposalType —
  // add `log_expense: 2` here. If not, the default below covers it.
};

/** Fallback for any ProposalType without an explicit entry above. */
export const DEFAULT_PROPOSAL_CREDIT_MINUTES = 3;

/** Minutes credited per voice call the agent handled end to end. */
export const CALL_HANDLED_CREDIT_MINUTES = 8;

/** Resolve the credit for a proposal type, applying the default fallback. */
export function creditForProposalType(type: ProposalType): number {
  const explicit = PROPOSAL_TIME_CREDITS[type];
  return explicit !== undefined ? explicit : DEFAULT_PROPOSAL_CREDIT_MINUTES;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/reports/time-credits.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/reports/time-credits.ts packages/api/test/reports/time-credits.test.ts
git commit -m "feat(api): add versioned time-credit constants for the time-given-back surface"
```

---

## Task 3: `computeTimeGivenBack` pure function

**Files:**
- Create: `packages/api/src/reports/time-given-back.ts`
- Test: `packages/api/test/reports/time-given-back.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/reports/time-given-back.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeTimeGivenBack,
  currentWeekWindow,
  TimeGivenBackInput,
} from '../../src/reports/time-given-back';
import { TIME_CREDIT_VERSION } from '../../src/reports/time-credits';
import type { Proposal, ProposalType, ProposalStatus } from '../../src/proposals/proposal';

const WEEK_START = new Date('2026-05-11T00:00:00.000Z');
const WEEK_END = new Date('2026-05-18T00:00:00.000Z');

function proposal(over: {
  proposalType: ProposalType;
  status?: ProposalStatus;
  executedAt?: Date;
  updatedAt?: Date;
}): Proposal {
  const now = new Date('2026-05-13T12:00:00.000Z');
  return {
    id: `prop-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    proposalType: over.proposalType,
    status: over.status ?? 'executed',
    payload: {},
    summary: 's',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: over.updatedAt ?? now,
    executedAt: over.executedAt ?? now,
  };
}

describe('computeTimeGivenBack', () => {
  const base: Omit<TimeGivenBackInput, 'proposals' | 'voiceSessions'> = {
    hourlyRateCents: 12000, // $120/hr
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  };

  it('sums credits for executed proposals inside the window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }), // 12 min
        proposal({ proposalType: 'record_payment' }), // 3 min
        proposal({ proposalType: 'add_note' }), // 1 min
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(16);
    expect(summary.receipt.proposalsHandled).toBe(3);
  });

  it('ignores proposals that are not executed', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate', status: 'executed' }),
        proposal({ proposalType: 'draft_estimate', status: 'draft' }),
        proposal({ proposalType: 'draft_estimate', status: 'rejected' }),
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(12);
    expect(summary.receipt.proposalsHandled).toBe(1);
  });

  it('ignores executed proposals outside the week window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-13') }),
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-01') }),
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-20') }),
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(12);
  });

  it('falls back to updatedAt when executedAt is missing', () => {
    const p = proposal({ proposalType: 'add_note' });
    delete (p as { executedAt?: Date }).executedAt;
    p.updatedAt = new Date('2026-05-13T09:00:00.000Z');
    const summary = computeTimeGivenBack({ ...base, proposals: [p], voiceSessions: [] });
    expect(summary.totalMinutes).toBe(1);
  });

  it('credits handled calls inside the window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [],
      voiceSessions: [
        { endedAt: new Date('2026-05-12') },
        { endedAt: new Date('2026-05-14') },
        { endedAt: new Date('2026-05-01') }, // outside window
        { endedAt: undefined }, // still open — not counted
      ],
    });
    expect(summary.totalMinutes).toBe(16); // 2 calls × 8 min
    expect(summary.receipt.callsAnswered).toBe(2);
  });

  it('converts minutes to hours and a dollar value via the hourly rate', () => {
    const summary = computeTimeGivenBack({
      ...base,
      hourlyRateCents: 12000,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_invoice' }),
        proposal({ proposalType: 'draft_invoice' }),
      ],
      // 12+12+8+8 = 40 min ... add a call for 8 → 48 min = 0.8 h
      voiceSessions: [{ endedAt: new Date('2026-05-12') }],
    });
    expect(summary.totalMinutes).toBe(48);
    expect(summary.totalHours).toBe(0.8);
    // 0.8 h × $120/h = $96.00 = 9600 cents
    expect(summary.dollarValueCents).toBe(9600);
  });

  it('returns dollarValueCents null when the hourly rate is unset', () => {
    const summary = computeTimeGivenBack({
      ...base,
      hourlyRateCents: null,
      proposals: [proposal({ proposalType: 'draft_estimate' })],
      voiceSessions: [],
    });
    expect(summary.totalHours).toBe(0.2);
    expect(summary.dollarValueCents).toBeNull();
  });

  it('records a per-type breakdown and stamps the credit version', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'record_payment' }),
      ],
      voiceSessions: [],
    });
    expect(summary.receipt.byProposalType.draft_estimate).toBe(2);
    expect(summary.receipt.byProposalType.record_payment).toBe(1);
    expect(summary.creditVersion).toBe(TIME_CREDIT_VERSION);
  });
});

describe('currentWeekWindow', () => {
  it('returns a 7-day [start, end) window ending at `now`', () => {
    const now = new Date('2026-05-14T15:30:00.000Z');
    const { weekStart, weekEnd } = currentWeekWindow(now);
    expect(weekEnd.getTime()).toBe(now.getTime());
    expect(weekEnd.getTime() - weekStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/reports/time-given-back.test.ts`
Expected: FAIL — `Cannot find module '../../src/reports/time-given-back'`.

- [ ] **Step 3: Write the pure function**

Create `packages/api/src/reports/time-given-back.ts`:

```typescript
import type { Proposal, ProposalType } from '../proposals/proposal';
import {
  TIME_CREDIT_VERSION,
  CALL_HANDLED_CREDIT_MINUTES,
  creditForProposalType,
} from './time-credits';

/**
 * §9 — the "Time Given Back" rollup.
 *
 * `computeTimeGivenBack` is pure: it takes already-fetched proposals
 * and voice sessions, a week window, and the tenant's hourly rate, and
 * returns the weekly summary + a legible receipt. Repositories fetch
 * the rows; this function owns the math.
 *
 * What counts:
 *  - Executed proposals (status === 'executed') whose executedAt — or
 *    updatedAt, if executedAt is missing on a historical row — falls
 *    inside [weekStart, weekEnd). Each credits `creditForProposalType`.
 *  - Voice sessions with an `endedAt` inside the window. Each credits
 *    `CALL_HANDLED_CREDIT_MINUTES`.
 */
export interface TimeGivenBackReceipt {
  /** Calls the agent handled end to end this week. */
  callsAnswered: number;
  /** Executed proposals counted this week. */
  proposalsHandled: number;
  /** Count of executed proposals by type — drives the legible receipt. */
  byProposalType: Partial<Record<ProposalType, number>>;
}

export interface TimeGivenBackSummary {
  /** ISO bounds of the window, echoed for the client. */
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  /** totalMinutes / 60, rounded to one decimal. */
  totalHours: number;
  /** totalHours × hourlyRateCents, integer cents — or null if rate unset. */
  dollarValueCents: number | null;
  receipt: TimeGivenBackReceipt;
  /** The time-credit calibration that produced these numbers. */
  creditVersion: string;
}

/** Minimal structural shape the rollup needs from a voice session. */
export interface CountableVoiceSession {
  endedAt?: Date;
}

export interface TimeGivenBackInput {
  proposals: Proposal[];
  voiceSessions: CountableVoiceSession[];
  hourlyRateCents: number | null;
  weekStart: Date;
  weekEnd: Date;
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

/** A 7-day [start, end) window ending at `now`. */
export function currentWeekWindow(now: Date): { weekStart: Date; weekEnd: Date } {
  const weekEnd = new Date(now.getTime());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { weekStart, weekEnd };
}

export function computeTimeGivenBack(input: TimeGivenBackInput): TimeGivenBackSummary {
  const { weekStart, weekEnd } = input;

  const byProposalType: Partial<Record<ProposalType, number>> = {};
  let proposalMinutes = 0;
  let proposalsHandled = 0;

  for (const p of input.proposals) {
    if (p.status !== 'executed') continue;
    const at = p.executedAt ?? p.updatedAt;
    if (!at || !inWindow(at, weekStart, weekEnd)) continue;
    proposalMinutes += creditForProposalType(p.proposalType);
    proposalsHandled += 1;
    byProposalType[p.proposalType] = (byProposalType[p.proposalType] ?? 0) + 1;
  }

  const callsAnswered = input.voiceSessions.filter(
    (s) => s.endedAt !== undefined && inWindow(s.endedAt, weekStart, weekEnd),
  ).length;
  const callMinutes = callsAnswered * CALL_HANDLED_CREDIT_MINUTES;

  const totalMinutes = proposalMinutes + callMinutes;
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const dollarValueCents =
    input.hourlyRateCents != null
      ? Math.round(totalHours * input.hourlyRateCents)
      : null;

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    totalMinutes,
    totalHours,
    dollarValueCents,
    receipt: { callsAnswered, proposalsHandled, byProposalType },
    creditVersion: TIME_CREDIT_VERSION,
  };
}

/**
 * Repository seam for the route. The reporter composes the existing
 * proposal / voice-session / settings repositories and runs
 * `computeTimeGivenBack`.
 */
export interface TimeGivenBackReporter {
  query(tenantId: string, now: Date): Promise<TimeGivenBackSummary>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/reports/time-given-back.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/reports/time-given-back.ts packages/api/test/reports/time-given-back.test.ts
git commit -m "feat(api): add computeTimeGivenBack pure function + reporter seam"
```

---

## Task 4: `RepoBackedTimeGivenBackReporter`

**Files:**
- Modify: `packages/api/src/reports/time-given-back.ts` (append the reporter implementation)
- Test: `packages/api/test/reports/time-given-back-reporter.test.ts`

- [ ] **Step 1: Read the voice-session module**

Open `packages/api/src/voice/voice-session.ts` and confirm: (a) the `VoiceSessionRepository` interface and its `findByTenant(tenantId, opts?)` signature, (b) the option name for filtering to ended sessions (an "ended only" style flag), (c) the in-memory implementation's class name. The reporter below uses `findByTenant` and treats rows structurally as `{ endedAt?: Date }` — adjust the option object key in Step 3 to the real name if it differs from `endedOnly`.

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/reports/time-given-back-reporter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RepoBackedTimeGivenBackReporter } from '../../src/reports/time-given-back';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string, hourlyRateCents: number | null): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    hourlyRateCents,
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal in-memory stand-in for the voice-session repo's findByTenant. */
class StubVoiceSessionRepo {
  constructor(private readonly rows: Array<{ tenantId: string; endedAt?: Date }>) {}
  async findByTenant(tenantId: string): Promise<Array<{ endedAt?: Date }>> {
    return this.rows.filter((r) => r.tenantId === tenantId);
  }
}

describe('RepoBackedTimeGivenBackReporter', () => {
  const NOW = new Date('2026-05-14T12:00:00.000Z');

  it('composes proposals + voice sessions + hourly rate into a summary', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', 12000));

    // An executed proposal inside the week window.
    const p = createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      payload: {},
      summary: 's',
      createdBy: 'u1',
    });
    await proposalRepo.create(p);
    await proposalRepo.updateStatus('t1', p.id, 'executed', { executedAt: NOW });

    const voiceRepo = new StubVoiceSessionRepo([
      { tenantId: 't1', endedAt: new Date('2026-05-13') },
      { tenantId: 't1', endedAt: undefined },
      { tenantId: 't2', endedAt: new Date('2026-05-13') },
    ]);

    const reporter = new RepoBackedTimeGivenBackReporter(
      proposalRepo,
      settingsRepo,
      voiceRepo,
    );
    const summary = await reporter.query('t1', NOW);

    expect(summary.receipt.proposalsHandled).toBe(1);
    expect(summary.receipt.callsAnswered).toBe(1);
    expect(summary.totalMinutes).toBe(20); // 12 (draft_estimate) + 8 (call)
    expect(summary.dollarValueCents).toBeGreaterThan(0);
  });

  it('returns dollarValueCents null when the tenant has no hourly rate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', null));
    const reporter = new RepoBackedTimeGivenBackReporter(
      proposalRepo,
      settingsRepo,
      new StubVoiceSessionRepo([]),
    );
    const summary = await reporter.query('t1', NOW);
    expect(summary.dollarValueCents).toBeNull();
  });

  it('works with no voice-session repo wired (calls contribute zero)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', 12000));
    const reporter = new RepoBackedTimeGivenBackReporter(proposalRepo, settingsRepo);
    const summary = await reporter.query('t1', NOW);
    expect(summary.receipt.callsAnswered).toBe(0);
    expect(summary.totalMinutes).toBe(0);
  });
});
```

- [ ] **Step 3: Append the reporter implementation**

Add to the end of `packages/api/src/reports/time-given-back.ts`:

```typescript
import type { ProposalRepository } from '../proposals/proposal';
import type { SettingsRepository } from '../settings/settings';

/**
 * The voice-session repo, structurally — the reporter only needs to
 * list a tenant's sessions and read each one's `endedAt`. Kept minimal
 * so the reporter does not couple to the full VoiceSessionRepository
 * surface (see packages/api/src/voice/voice-session.ts).
 */
export interface CountableVoiceSessionRepository {
  findByTenant(tenantId: string): Promise<CountableVoiceSession[]>;
}

/**
 * Production + test reporter. Composes the existing tenant-scoped
 * repositories — each already RLS-scoped — and runs the single tested
 * `computeTimeGivenBack`. One implementation serves both the Pg and
 * in-memory boot paths because the repositories abstract storage.
 *
 * `voiceSessionRepo` is optional: if it is not wired, handled-call
 * credits contribute zero rather than failing the whole rollup.
 */
export class RepoBackedTimeGivenBackReporter implements TimeGivenBackReporter {
  constructor(
    private readonly proposalRepo: ProposalRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly voiceSessionRepo?: CountableVoiceSessionRepository,
  ) {}

  async query(tenantId: string, now: Date): Promise<TimeGivenBackSummary> {
    const { weekStart, weekEnd } = currentWeekWindow(now);
    const [proposals, settings, voiceSessions] = await Promise.all([
      this.proposalRepo.findByTenant(tenantId),
      this.settingsRepo.findByTenant(tenantId),
      this.voiceSessionRepo
        ? this.voiceSessionRepo.findByTenant(tenantId)
        : Promise.resolve([] as CountableVoiceSession[]),
    ]);
    return computeTimeGivenBack({
      proposals,
      voiceSessions,
      hourlyRateCents: settings?.hourlyRateCents ?? null,
      weekStart,
      weekEnd,
    });
  }
}
```

> The three `import type` lines must sit at the top of the file with the other imports — move them up rather than leaving them mid-file. They are type-only imports, so there is no circular-import risk.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/reports/time-given-back-reporter.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/reports/time-given-back.ts packages/api/test/reports/time-given-back-reporter.test.ts
git commit -m "feat(api): add RepoBackedTimeGivenBackReporter"
```

---

## Task 5: `GET /api/reports/time-given-back` endpoint

**Files:**
- Modify: `packages/api/src/routes/reports.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/routes/reports.route.test.ts`
- Test: `packages/api/test/routes/time-given-back.route.test.ts` (create)

- [ ] **Step 1: Write the failing route-shape test**

Create `packages/api/test/routes/time-given-back.route.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { RepoBackedTimeGivenBackReporter } from '../../src/reports/time-given-back';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    hourlyRateCents: 12000,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildApp() {
  const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create(makeSettings('tenant-r1'));
  const timeGivenBackReporter = new RepoBackedTimeGivenBackReporter(
    proposalRepo,
    settingsRepo,
  );
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: 'tenant-r1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/reports', createReportsRouter({ revenueBySourceRepo, timeGivenBackReporter }));
  return { app, proposalRepo };
}

describe('GET /api/reports/time-given-back', () => {
  it('returns a zeroed summary under data when there is no activity', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalMinutes: 0, totalHours: 0 });
    expect(res.body.data.creditVersion).toBeDefined();
  });

  it('reflects an executed proposal in the weekly total', async () => {
    const { app, proposalRepo } = await buildApp();
    const p = createProposal({
      tenantId: 'tenant-r1',
      proposalType: 'draft_estimate',
      payload: {},
      summary: 's',
      createdBy: 'user-r1',
    });
    await proposalRepo.create(p);
    await proposalRepo.updateStatus('tenant-r1', p.id, 'executed', {
      executedAt: new Date(),
    });
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.proposalsHandled).toBe(1);
    expect(res.body.data.totalMinutes).toBeGreaterThan(0);
  });

  it('returns 503 when the reporter is not configured', async () => {
    const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u',
        sessionId: 's',
        tenantId: 'tenant-r1',
        role: 'owner',
      };
      next();
    });
    app.use('/api/reports', createReportsRouter({ revenueBySourceRepo }));
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/routes/time-given-back.route.test.ts`
Expected: FAIL — `createReportsRouter` does not accept an options object / the route 404s.

- [ ] **Step 3: Convert `createReportsRouter` to an options object and add the endpoint**

Replace the body of `packages/api/src/routes/reports.ts` with:

```typescript
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RevenueBySourceRepository } from '../reports/revenue-by-source';
import { TimeGivenBackReporter } from '../reports/time-given-back';

/**
 * Tenant-scoped reporting endpoints. Add new reports here rather than
 * spinning up a separate router per metric.
 *
 * The signature is an options object so multiple launch plans can each
 * add a report without colliding on positional params (see §8 / §9
 * plans). All deps beyond `revenueBySourceRepo` are optional; a route
 * 503s if its dep is absent.
 */
export interface ReportsRouterDeps {
  revenueBySourceRepo: RevenueBySourceRepository;
  timeGivenBackReporter?: TimeGivenBackReporter;
}

export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const router = Router();

  router.get(
    '/revenue-by-source',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        const from = fromRaw ? new Date(fromRaw) : undefined;
        const to = toRaw ? new Date(toRaw) : undefined;
        if (fromRaw && Number.isNaN(from!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from` date' });
          return;
        }
        if (toRaw && Number.isNaN(to!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `to` date' });
          return;
        }
        const rows = await deps.revenueBySourceRepo.query(req.auth!.tenantId, { from, to });
        res.json({ data: rows });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/time-given-back',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.timeGivenBackReporter) {
          res
            .status(503)
            .json({ error: 'NOT_CONFIGURED', message: 'Time-given-back report unavailable' });
          return;
        }
        const summary = await deps.timeGivenBackReporter.query(req.auth!.tenantId, new Date());
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
```

> **If the §8 (Money Dashboard) plan has already landed**, `reports.ts` is already an options-object router with a `ReportsRouterDeps` interface. In that case do **not** replace the file — just add `timeGivenBackReporter?: TimeGivenBackReporter;` to the existing `ReportsRouterDeps` interface, add the `import { TimeGivenBackReporter } ...` line, and add the `/time-given-back` route handler block above. Leave §8's `/money-dashboard` and `/tax-export` routes intact.

- [ ] **Step 4: Update the existing `reports.route.test.ts` for the new signature**

In `packages/api/test/routes/reports.route.test.ts`, update `buildApp()` — change the router construction from positional to the options object:

```typescript
  app.use('/api/reports', createReportsRouter({ revenueBySourceRepo: repo }));
```

(The variable is named `repo` in that file — keep it; only the call changes.)

- [ ] **Step 5: Update `app.ts` wiring**

In `packages/api/src/app.ts`, find the reports router block (lines ~1909-1912). Replace it with:

```typescript
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();
  const timeGivenBackReporter = new RepoBackedTimeGivenBackReporter(
    proposalRepo,
    settingsRepo,
    voiceSessionRepo,
  );
  app.use(
    '/api/reports',
    createReportsRouter({ revenueBySourceRepo, timeGivenBackReporter }),
  );
```

Add the import near the other reports imports at the top of `app.ts`:

```typescript
import { RepoBackedTimeGivenBackReporter } from './reports/time-given-back';
```

> `proposalRepo` and `settingsRepo` are already constructed in `app.ts` (they back the proposals and settings routers) — reuse those exact variable names. `voiceSessionRepo` is the variable name app.ts uses for the voice-session repository; confirm the name in `app.ts` and use it. If no voice-session repo variable exists in `app.ts`, omit the third argument — `RepoBackedTimeGivenBackReporter`'s third parameter is optional and handled-call credits will simply contribute zero until it is wired.
>
> If the §8 plan has already converted `createReportsRouter` to an options object, this `app.use('/api/reports', ...)` call already passes an object — just add the `timeGivenBackReporter` key to the existing object instead of replacing the block.

- [ ] **Step 6: Run both route tests**

Run: `cd packages/api && npm test -- test/routes/time-given-back.route.test.ts test/routes/reports.route.test.ts`
Expected: PASS (all cases in both files).

- [ ] **Step 7: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/routes/reports.ts packages/api/src/app.ts packages/api/test/routes/reports.route.test.ts packages/api/test/routes/time-given-back.route.test.ts
git commit -m "feat(api): add /api/reports/time-given-back endpoint"
```

---

## Task 6: Home-screen `TimeGivenBackCard`

**Files:**
- Create: `packages/web/src/components/home/TimeGivenBackCard.tsx`
- Modify: `packages/web/src/components/home/HomePage.tsx`

- [ ] **Step 1: Write the card component**

A self-contained widget: it does its own fetch (so it does not bloat `HomePage`), mirrors the `useApiClient` pattern from `RevenueBySourcePage.tsx`, and degrades gracefully — a loading skeleton, a silent failure (the home screen must not break if one widget fails), an "hours only" headline when no hourly rate is set, and an empty-state line when there is nothing yet.

Create `packages/web/src/components/home/TimeGivenBackCard.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

interface TimeGivenBackReceipt {
  callsAnswered: number;
  proposalsHandled: number;
  byProposalType: Record<string, number>;
}

interface TimeGivenBackSummary {
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  totalHours: number;
  dollarValueCents: number | null;
  receipt: TimeGivenBackReceipt;
  creditVersion: string;
}

function formatHours(hours: number): string {
  if (hours === 0) return '0 hours';
  if (hours === 1) return '1 hour';
  return `${hours} hours`;
}

function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

export function TimeGivenBackCard() {
  const apiFetch = useApiClient();
  const [summary, setSummary] = useState<TimeGivenBackSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/reports/time-given-back')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as TimeGivenBackSummary);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // A widget failure must never break the home screen — render nothing.
  if (failed) return null;

  if (isLoading) {
    return (
      <div className="mx-4 md:mx-6 mt-4 h-20 rounded-xl bg-slate-100 animate-pulse" />
    );
  }

  if (!summary) return null;

  const { totalHours, dollarValueCents, receipt } = summary;
  const headline =
    dollarValueCents != null
      ? `${formatHours(totalHours)} given back ≈ ${formatDollars(dollarValueCents)}`
      : `${formatHours(totalHours)} given back`;

  const receiptParts: string[] = [];
  if (receipt.callsAnswered > 0) {
    receiptParts.push(
      `${receipt.callsAnswered} call${receipt.callsAnswered === 1 ? '' : 's'} answered`,
    );
  }
  if (receipt.proposalsHandled > 0) {
    receiptParts.push(
      `${receipt.proposalsHandled} action${receipt.proposalsHandled === 1 ? '' : 's'} handled for you`,
    );
  }

  return (
    <div className="mx-4 md:mx-6 mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3.5">
      <p className="text-xs text-blue-600 uppercase tracking-wide">This week</p>
      <p className="text-xl font-semibold text-blue-900 mt-1">{headline}</p>
      {receiptParts.length > 0 ? (
        <p className="text-sm text-blue-700 mt-1">{receiptParts.join(' · ')}</p>
      ) : (
        <p className="text-sm text-blue-700/70 mt-1">
          Your time-saved tally will grow as the AI handles calls and work for you.
        </p>
      )}
      {dollarValueCents == null && totalHours > 0 && (
        <p className="text-xs text-blue-600/70 mt-1">
          Set your hourly rate in Settings to see the dollar value.
        </p>
      )}
    </div>
  );
}
```

> If `useApiClient`'s returned function does not resolve to a `Response` (check `packages/web/src/lib/apiClient.ts` — it may return parsed JSON directly), adapt the `.then`/`res.ok`/`res.json()` calls to that contract. `RevenueBySourcePage.tsx` is the reference for the exact shape in this codebase — match it.

- [ ] **Step 2: Render the card on `HomePage`**

In `packages/web/src/components/home/HomePage.tsx`:

Add the import near the top with the other component imports:

```typescript
import { TimeGivenBackCard } from './TimeGivenBackCard';
```

In the JSX, insert `<TimeGivenBackCard />` between the closing `</div>` of the `{/* ── Header ── */}` block and the `{/* ── Two-column layout ── */}` `<div>` — so it is the first thing the owner sees below the header, above today's jobs:

```tsx
        </div>
        {/* ── Time given back ── */}
        <TimeGivenBackCard />
        {/* ── Two-column layout ── */}
        <div className="flex flex-col md:grid md:grid-cols-[1fr_320px] ...
```

> The exact closing `</div>` of the header block is the one immediately before the `{/* ── Two-column layout ── */}` comment (around line 302–303). Place the card between them.

- [ ] **Step 3: Web typecheck**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/home/TimeGivenBackCard.tsx packages/web/src/components/home/HomePage.tsx
git commit -m "feat(web): add Time Given Back card to the home screen"
```

---

## Task 7: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Full API test suite**

Run: `cd packages/api && npm test`
Expected: all tests pass, including the new `hourly-rate`, `time-credits`, `time-given-back`, `time-given-back-reporter`, and `time-given-back.route` files, plus the updated `reports.route.test.ts`. If `decisions.test.ts` runs, confirm it stays green — this plan adds no proposal type and changes no auto-approval behavior, so the 12 founding decisions are unaffected.

- [ ] **Step 2: API production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Web typecheck**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Confirm the migration is well-formed**

Visually confirm in `packages/api/src/db/schema.ts` that the `097_add_tenant_hourly_rate` key is present in `MIGRATIONS` and uses `ADD COLUMN IF NOT EXISTS` (idempotent — the whole SQL re-runs on every boot).

- [ ] **Step 5: Review the diff against the spec**

Confirm against §9 of `docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md`:
- ✅ Home-screen headline — estimated time given back this week — computed from real, typed records (`proposals` + `voice_sessions`), not vibes: `TimeGivenBackCard` at the top of `HomePage`.
- ✅ Each automated action carries a small, fixed, **versioned** time-credit: `time-credits.ts` with `TIME_CREDIT_VERSION`, `PROPOSAL_TIME_CREDITS`, `CALL_HANDLED_CREDIT_MINUTES`.
- ✅ Sum the credits over the week: `computeTimeGivenBack` over a 7-day window.
- ✅ Backed by a legible receipt ("N calls answered, N actions handled"): `TimeGivenBackSummary.receipt` with `callsAnswered`, `proposalsHandled`, `byProposalType`.
- ✅ Time + money equivalent (hours × hourly rate): `dollarValueCents`, with `hourlyRateCents` added to `tenant_settings`; degrades to hours-only when unset.
- ✅ Credits are tunable constants, versioned, recalibration-safe: a `Partial` map + default + version string; changing a number + bumping the version is the entire recalibration.
- ⚠️ Dependency note (documented, not a gap): the receipt's per-action richness grows as more event sources land — §1's voice-call detail and §7's confirmation/reminder sends. The credit model is built to absorb them (add a credit constant; the pure function is unchanged). At launch the receipt is driven by executed proposals + handled calls, which exist today.

- [ ] **Step 6: Commit any verification fixes, then finish the branch**

If steps 1–4 surfaced fixes, commit them. Then use the **superpowers:finishing-a-development-branch** skill to decide how to integrate (PR vs. merge).

---

## Self-Review

**Spec coverage:** Every element of §9's minimum credible version and fork decision maps to a task — versioned credits (Task 2), weekly aggregation from real records (Tasks 3–4), the receipt (Task 3's `TimeGivenBackReceipt`), the hours + dollar headline (Task 3 + Task 1's `hourlyRateCents`), the home-screen widget (Task 6), and the endpoint that connects them (Task 5). The one dependency note (richer receipt as §1/§7 land more event sources) is called out explicitly in Task 7 Step 5 — it is an extension point, not a gap; the launch surface is complete with proposals + calls.

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases". Every code step shows the full file or the exact edit. The `>` notes are defensive instructions for shape-mismatches the executing engineer may hit (`useApiClient` return type, the voice-session repo's option name, `app.ts` variable names, the §8-landed-first branch) — each points at a real, named source file, not vague guidance. Task 1 Steps 6–7 instruct "follow the `depositFixedCents` pattern" — `depositFixedCents` is a real, named, identically-shaped (`number | null`) field, and the work (add to `mapRow`, add to the `update` field-map, add to the route whitelist) is mechanical pattern-matching, the same approach the §6 time-to-cash plan uses for Pg field-mapping.

**Type consistency:** `TIME_CREDIT_VERSION` / `PROPOSAL_TIME_CREDITS` / `CALL_HANDLED_CREDIT_MINUTES` / `creditForProposalType` are defined in Task 2 and consumed in Task 3. `TimeGivenBackSummary` / `TimeGivenBackInput` / `TimeGivenBackReceipt` / `CountableVoiceSession` / `computeTimeGivenBack` / `currentWeekWindow` / `TimeGivenBackReporter` are defined in Task 3; `RepoBackedTimeGivenBackReporter` / `CountableVoiceSessionRepository` are appended in Task 4; all are consumed unchanged in Task 5 and Task 6 (the web `TimeGivenBackSummary` interface is a structural mirror). `hourlyRateCents` is added to `TenantSettings` in Task 1 and read in Task 4's reporter. `createReportsRouter`'s new `ReportsRouterDeps` object signature is defined in Task 5 and matched by the new test, the updated existing test, and `app.ts`.

**Known cross-plan merge point:** `createReportsRouter`, `reports.ts`, the `app.use('/api/reports', ...)` call site, `reports.route.test.ts`, and `packages/api/src/db/schema.ts` migration keys are also touched by the §8 (Money Dashboard) plan. Both plans converge on the same options-object `createReportsRouter` signature; Task 5 Step 3 and Step 5 each carry an explicit "if §8 landed first" branch, and the migration-key note in Context handles key uniqueness.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-time-given-back-surface.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
