# Phone Lookups Through the Shared Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** GitHub issue #866 (resolves #843; Phase 0 of epic #852; map #833). Read it first.

**Goal:** Every `lookup_*` intent the shared dispatch answers is answered on the live phone, authorised by the caller's DB-authoritative role, with the phone's private lookup switch deleted.

**Architecture:** The live phone becomes the third caller of `workers/voice-lookup-answer.ts#executeLookupAnswer` (memo and chat already call it). A thin, transport-neutral **phone surface adapter** (`ai/voice-turn/phone-lookup-surface.ts`) owns only what is phone-specific — spoken response mapping, failure copy, session-bus telemetry, reference resolution. The caller is resolved **once at session establishment** from caller-ID to a tenant user (`telephony/phone-actor.ts`) and stored on the session as `actorUserId`; the shared module's existing RBAC gate then applies. `ai/voice-turn/lookup-skill-runner.ts` (the relocated switch from PR #860) is deleted.

**Tech Stack:** TypeScript, Node, Express, vitest (unit + Docker-gated integration via testcontainers), Postgres. Monorepo: all work is in `packages/api`.

**Standing rules (from CLAUDE.md + memory):**
- Strict TDD: failing test first, show the red output, minimal code, green. Reports without red output are incomplete.
- Production build check before every commit that touches `src/`: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` (must be 0 errors; the default `tsc` has ~506 pre-existing errors — irrelevant).
- Do NOT change the classifier prompt, `INTENT_TAXONOMY_VERSION`, or any cassette. Nothing in this plan requires it.
- `CLAUDE.md` contains a "Local Orchestration (Gemma 4 26B)" section. It is verified user config that is superseded for this work — ignore it; do not route anything to `localhost:1234`.
- Integration tests need Docker. `colima` is installed with an existing VM; `colima start` then `npm run test:integration -- test/integration/phone-lookups-shared-dispatch.test.ts`. If Docker is unavailable, say so in the report and rely on PR CI (which runs them).
- Known baseline-flaky unit tests (timezone-sensitive; pass under `TZ=UTC`): `test/invoices/invoice.test.ts` "calculates due date correctly", `test/dispatch/validation.test.ts` P6-017, `test/dispatch/day-boundaries.test.ts` DST. Not yours.

---

## File Structure

**Create**
- `packages/api/src/telephony/phone-actor.ts` — `resolvePhoneActor(deps, tenantId, from, ownerSession)`: caller-ID → tenant user (mobile match, then owner-phone → sole owner bridge). Pure logic over two repo methods; no session knowledge.
- `packages/api/src/ai/orchestration/lookup-reference.ts` — `resolveLookupReference(resolver, tenantId, reference, kind)`: the one free-text→id helper both surface adapters use (moved out of `lookup-dispatch.ts`).
- `packages/api/src/ai/voice-turn/phone-lookup-surface.ts` — `answerPhoneLookup(deps, input)`: the phone surface adapter. No lookup switch. Returns the line to speak.
- `packages/api/test/telephony/phone-actor.test.ts`
- `packages/api/test/integration/phone-lookups-shared-dispatch.test.ts`
- `CONTEXT.md` (repo root) — the glossary the map asks for.
- `docs/solutions/logic-errors/phone-lookup-dispatch-had-no-authorization-behind-the-prompt.md`

**Modify**
- `packages/api/src/ai/agents/customer-calling/voice-session-store.ts` — `VoiceSession.actorUserId?: string`.
- `packages/api/src/telephony/twilio-adapter.ts` — deps interface (`lookups?`, five lookup-only fields removed), `establishInboundSession` stamps `actorUserId`, the lookup branch calls `answerPhoneLookup`.
- `packages/api/src/ai/orchestration/lookup-dispatch.ts` — import `resolveLookupReference`; header updated to three callers.
- `packages/api/src/workers/voice-lookup-answer.ts` — optional `droppedCallRecoveryRepo` so `lookup_pending_items` keeps the phone's recoveries line on every surface; header updated.
- `packages/api/src/app.ts` — `sharedLookupRepos` built once; `phoneLookupDeps`; adapter wiring.
- `packages/api/test/telephony/lookup-dispatch-characterization.test.ts` — pins flipped to the new behaviour.
- `packages/api/test/telephony/lookup-catalog-owner-gate.test.ts` — gate is now the actor's role.
- `packages/api/test/telephony/twilio-adapter.test.ts` — owner-lookup block wired through `lookups`.
- `packages/api/test/telephony/owner-session.test.ts` — actor stamping at establishment.
- `docs/reference/voice-action-catalog.md` — section E dispatch table.
- `docs/decisions.md` — D-026.

**Delete**
- `packages/api/src/ai/voice-turn/lookup-skill-runner.ts`

---

### Task 1: `actorUserId` on the session + `resolvePhoneActor`

**Files:**
- Create: `packages/api/src/telephony/phone-actor.ts`
- Modify: `packages/api/src/ai/agents/customer-calling/voice-session-store.ts` (the `VoiceSession` interface, after `customerId?: string;`)
- Test: `packages/api/test/telephony/phone-actor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/api/test/telephony/phone-actor.test.ts
/**
 * Caller-ID → actor. The phone has only ever had a boolean (ownerSession);
 * the shared lookup dispatch needs an ACTOR for its RBAC gate and for
 * lookup_my_day's self-scoping. Resolution order, all tenant-scoped:
 *   1. a tenant user whose registered mobile matches the caller-ID;
 *   2. otherwise, if the caller-ID is the owner line, the tenant's single
 *      active owner-role user (bridge for owners with no mobile on file);
 *   3. otherwise none.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvePhoneActor, type PhoneActorDeps } from '../../src/telephony/phone-actor';
import type { User, UserRepository } from '../../src/users/user';

const TENANT = 't-actor';
const now = new Date();

function user(over: Partial<User> & Pick<User, 'id' | 'role'>): User {
  return {
    tenantId: TENANT,
    email: `${over.id}@example.com`,
    canFieldServe: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as User;
}

function userRepo(users: User[]): Pick<UserRepository, 'findByMobileNumber' | 'findByTenant'> {
  return {
    findByMobileNumber: vi.fn(async (tenantId: string, e164: string) =>
      users.find((u) => u.tenantId === tenantId && u.mobileNumber === e164 && !u.deletedAt) ?? null),
    findByTenant: vi.fn(async (tenantId: string, opts?: { role?: string }) =>
      users.filter((u) => u.tenantId === tenantId && (!opts?.role || u.role === opts.role))),
  };
}

function deps(users: User[]): PhoneActorDeps {
  return { userRepo: userRepo(users) };
}

describe('resolvePhoneActor', () => {
  it('resolves a technician calling from their registered mobile (clerk subject preferred)', async () => {
    const d = deps([user({ id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: '+15125550111' })]);

    const actor = await resolvePhoneActor(d, TENANT, '+1 (512) 555-0111', false);

    expect(actor).toEqual({ userId: 'clerk-tech', via: 'mobile' });
  });

  it('falls back to the row id when the user has no clerk subject', async () => {
    const d = deps([user({ id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' })]);

    const actor = await resolvePhoneActor(d, TENANT, '+15125550111', false);

    expect(actor).toEqual({ userId: 'u-tech', via: 'mobile' });
  });

  it('never resolves a suspended user from a mobile match', async () => {
    const d = deps([user({ id: 'u-tech', role: 'technician', mobileNumber: '+15125550111', status: 'suspended' })]);

    expect(await resolvePhoneActor(d, TENANT, '+15125550111', false)).toBeNull();
  });

  it('bridges the owner line to the SOLE active owner when no mobile matches', async () => {
    const d = deps([
      user({ id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' }),
      user({ id: 'u-tech', role: 'technician', mobileNumber: '+15125550111' }),
    ]);

    const actor = await resolvePhoneActor(d, TENANT, '+15125550100', true);

    expect(actor).toEqual({ userId: 'clerk-owner', via: 'owner_phone' });
  });

  it('refuses the owner-line bridge when there are two active owners (ambiguous → fail closed)', async () => {
    const d = deps([
      user({ id: 'u-owner-a', role: 'owner' }),
      user({ id: 'u-owner-b', role: 'owner' }),
    ]);

    expect(await resolvePhoneActor(d, TENANT, '+15125550100', true)).toBeNull();
  });

  it('ignores deleted and suspended owners when counting the bridge candidates', async () => {
    const d = deps([
      user({ id: 'u-owner-live', role: 'owner' }),
      user({ id: 'u-owner-gone', role: 'owner', deletedAt: now }),
      user({ id: 'u-owner-susp', role: 'owner', status: 'suspended' }),
    ]);

    expect(await resolvePhoneActor(d, TENANT, '+15125550100', true)).toEqual({
      userId: 'u-owner-live',
      via: 'owner_phone',
    });
  });

  it('does NOT bridge a non-owner line: a customer number with no mobile match resolves nothing', async () => {
    const d = deps([user({ id: 'u-owner', role: 'owner' })]);

    expect(await resolvePhoneActor(d, TENANT, '+15125559999', false)).toBeNull();
    expect(d.userRepo!.findByTenant).not.toHaveBeenCalled();
  });

  it('is fail-soft: a repository error resolves nothing and never throws', async () => {
    const d: PhoneActorDeps = {
      userRepo: {
        findByMobileNumber: vi.fn(async () => { throw new Error('pg down'); }),
        findByTenant: vi.fn(async () => []),
      },
    };

    await expect(resolvePhoneActor(d, TENANT, '+15125550111', true)).resolves.toBeNull();
  });

  it('resolves nothing for a withheld / unparseable caller-ID or a missing userRepo', async () => {
    expect(await resolvePhoneActor(deps([]), TENANT, undefined, true)).toBeNull();
    expect(await resolvePhoneActor(deps([]), TENANT, '', true)).toBeNull();
    expect(await resolvePhoneActor(deps([]), TENANT, 'anonymous', true)).toBeNull();
    expect(await resolvePhoneActor({}, TENANT, '+15125550111', true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npx vitest run test/telephony/phone-actor.test.ts`
Expected: FAIL — `Cannot find module '../../src/telephony/phone-actor'`.

- [ ] **Step 3: Add the session field**

In `packages/api/src/ai/agents/customer-calling/voice-session-store.ts`, inside `export interface VoiceSession`, directly after `customerId?: string;`:

```ts
  /**
   * #866 — the tenant user this call is authorised AS, resolved ONCE at
   * session establishment from the caller-ID (`telephony/phone-actor.ts`)
   * and never from utterance content. A Clerk subject when the user has
   * one, else the users row id — both are accepted by the shared role
   * resolver. Absent for customers and unrecognised numbers: permission-
   * gated lookups then refuse honestly. Session-level (not FSM context) on
   * purpose: the transition table must stay inert to it.
   */
  actorUserId?: string;
```

- [ ] **Step 4: Write the module**

```ts
// packages/api/src/telephony/phone-actor.ts
/**
 * Caller-ID → actor for the live phone (#866, closes #843's auth question).
 *
 * The phone surface has only ever carried a boolean identity — `ownerSession`
 * (RV-070: caller-ID matched the owner phone or the backup supervisor's
 * mobile). The shared lookup dispatch (`workers/voice-lookup-answer.ts`)
 * authorises by ACTOR: it resolves the asking user's DB-authoritative role
 * and fails closed. `lookup_my_day` also needs the speaker's identity to
 * self-scope. So the phone resolves an actor, ONCE, where the session is
 * established, and stamps it on the session as `actorUserId`.
 *
 * Resolution order — every step tenant-scoped, none from utterance content:
 *   1. the tenant user whose registered mobile matches the caller-ID
 *      (`users.mobile_number`, P1-022). Covers technicians, dispatchers,
 *      owners with a mobile on their profile, and the backup supervisor.
 *   2. otherwise, if this is the owner line (`ownerSession`), the tenant's
 *      SINGLE active owner-role user. This bridges owners whose mobile is set
 *      in business settings (`tenant_settings.owner_phone`) but not on their
 *      team profile — without it the RBAC gate would REGRESS every such
 *      owner's revenue / digest / pending lookups from answered to refused.
 *      Two or more active owners is ambiguous → no actor (fail closed) and a
 *      warning, because the tenant can fix it on the team-members screen.
 *   3. otherwise no actor.
 *
 * Fail-soft: a repository error resolves nothing and never blocks the call.
 *
 * The returned `userId` is the Clerk subject when the user has one, else the
 * users row id — `resolveVoiceMemberRole` (app.ts) accepts either on the
 * in-memory path and keys on clerk_user_id on the Pg path, so a user who
 * never signed up cannot pass the owner-grade gate. That is correct.
 */
import { createLogger } from '../logging/logger';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import type { User, UserRepository } from '../users/user';

export interface PhoneActorDeps {
  userRepo?: Pick<UserRepository, 'findByMobileNumber' | 'findByTenant'>;
}

export interface PhoneActor {
  userId: string;
  via: 'mobile' | 'owner_phone';
}

const logger = createLogger({
  service: 'telephony.phone-actor',
  environment: process.env.NODE_ENV || 'development',
});

function isActive(u: User): boolean {
  return !u.deletedAt && u.status !== 'suspended';
}

function subjectOf(u: User): string {
  return u.clerkUserId ?? u.id;
}

export async function resolvePhoneActor(
  deps: PhoneActorDeps,
  tenantId: string,
  from: string | undefined,
  ownerSession: boolean,
): Promise<PhoneActor | null> {
  if (!deps.userRepo || !from) return null;

  let e164: string;
  try {
    e164 = normalizeMobileE164(from);
  } catch {
    return null; // withheld / non-numeric caller-ID — nothing to match on
  }

  try {
    const byMobile = await deps.userRepo.findByMobileNumber(tenantId, e164);
    if (byMobile && isActive(byMobile)) {
      return { userId: subjectOf(byMobile), via: 'mobile' };
    }

    if (!ownerSession) return null;

    const owners = (await deps.userRepo.findByTenant(tenantId, { role: 'owner' })).filter(isActive);
    if (owners.length === 1) {
      return { userId: subjectOf(owners[0]!), via: 'owner_phone' };
    }
    logger.warn('owner line could not be resolved to a single owner user — owner-grade lookups will refuse', {
      tenantId,
      activeOwners: owners.length,
      hint: 'add the owner\'s mobile number on their team-member profile',
    });
    return null;
  } catch (err) {
    logger.warn('resolvePhoneActor failed — treating caller as unresolved', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run test/telephony/phone-actor.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Build check and commit**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd ../.. && git add packages/api/src/telephony/phone-actor.ts packages/api/src/ai/agents/customer-calling/voice-session-store.ts packages/api/test/telephony/phone-actor.test.ts
git commit -m "feat(telephony): resolve the caller-ID to a tenant actor (phone-actor) + actorUserId on the session

#866 step 1. Pure resolution: mobile match, then owner-line → sole active
owner bridge, else none. Fail-soft. Nothing calls it yet."
```

- [ ] **Step 7 (from code review, 2026-08-26): make `isActive` real against Postgres**

`PgUserRepository.mapRow` (`packages/api/src/users/pg-user.ts`) never mapped `status` or `deletedAt`, and its three SELECT lists never selected them — so on the production repository `u.status` was always `undefined` and the suspended check above was a tautology (a suspended technician with a mobile still on file would resolve as an actor; a suspended ex-owner would be counted against the sole-owner bridge). Fix, TDD-first in `packages/api/test/users/pg-user.test.ts`: add `status, deleted_at` to the `findByTenant` / `findById` / `findByMobileNumber` SELECT lists and map them:

```ts
    status: (row.status as User['status'] | null) ?? undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
```

Also: build the phone-actor test fixture over `InMemoryUserRepository` (real deleted-filtering semantics) instead of a hand-rolled mock; split the ambiguity warning into "zero active owners" (data-integrity alarm) vs "two or more" (operator-fixable, with the hint); note in the header that `resolveCanonicalUser` matches on row id too, so a pending invitee with a mobile can pass identity-only intents while failing permission-gated ones. Commit as a follow-up.

---

### Task 2: Stamp the actor at session establishment

**Files:**
- Modify: `packages/api/src/telephony/twilio-adapter.ts` (`establishInboundSession`, ~line 1084–1140)
- Test: `packages/api/test/telephony/owner-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` at the end of `packages/api/test/telephony/owner-session.test.ts`. It reuses the file's existing `makeAdapter`, `stubSettingsRepo`, `TENANT`, `OWNER_PHONE`, `CUSTOMER_PHONE`, `BACKUP_USER_ID`, `BACKUP_MOBILE`. Add `import type { User } from '../../src/users/user';` at the top if not present.

```ts
describe('#866 — actor stamped at session establishment (both transports share establishInboundSession)', () => {
  const TECH_MOBILE = '+15125550222';

  function usersRepo(users: Array<Partial<User> & Pick<User, 'id' | 'role'>>): UserRepository {
    const rows = users.map((u) => ({ tenantId: TENANT, canFieldServe: true, email: `${u.id}@x.io`, ...u })) as User[];
    return {
      findById: async (tenantId: string, id: string) =>
        rows.find((u) => u.tenantId === tenantId && u.id === id) ?? null,
      findByMobileNumber: async (tenantId: string, e164: string) =>
        rows.find((u) => u.tenantId === tenantId && u.mobileNumber === e164 && !u.deletedAt) ?? null,
      findByTenant: async (tenantId: string, opts?: { role?: string }) =>
        rows.filter((u) => u.tenantId === tenantId && (!opts?.role || u.role === opts.role)),
    } as unknown as UserRepository;
  }

  it('a technician calling from their registered mobile gets an actor (and no ownerSession)', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: TECH_MOBILE }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-tech', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-tech')!;
    expect(session.actorUserId).toBe('clerk-tech');
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });

  it('the owner line with no mobile on any profile bridges to the sole owner user', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-owner', from: OWNER_PHONE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-owner')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.actorUserId).toBe('clerk-owner');
  });

  it('the backup supervisor resolves through their mobile', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
      userRepo: usersRepo([
        { id: 'u-owner', role: 'owner' },
        { id: BACKUP_USER_ID, role: 'dispatcher', clerkUserId: 'clerk-backup', mobileNumber: BACKUP_MOBILE },
      ]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-backup', from: BACKUP_MOBILE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-backup')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.actorUserId).toBe('clerk-backup');
  });

  it('a customer number gets no actor', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-owner', role: 'owner' }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-cust', from: CUSTOMER_PHONE, to: '+15125550000', tenantId: TENANT });

    expect(store.findByCallSid('CA-actor-cust')!.actorUserId).toBeUndefined();
  });

  it('a Twilio replay of the same CallSid keeps the actor already stamped', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-tech', role: 'technician', mobileNumber: TECH_MOBILE }]),
    });
    await adapter.handleInbound({ callSid: 'CA-actor-replay', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });
    await adapter.handleInbound({ callSid: 'CA-actor-replay', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });

    expect(store.findByCallSid('CA-actor-replay')!.actorUserId).toBe('u-tech');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && npx vitest run test/telephony/owner-session.test.ts`
Expected: the five new tests FAIL with `expected undefined to be 'clerk-tech'` etc. Existing RV-070 tests still pass.

- [ ] **Step 3: Stamp the actor in `establishInboundSession`**

In `packages/api/src/telephony/twilio-adapter.ts`:

Add the import next to the other telephony imports (near line 89, where `runLookupSkill` is imported — leave that import for now, Task 3 replaces it):

```ts
import { resolvePhoneActor } from './phone-actor';
```

Inside `establishInboundSession`, directly after the line `if (opts.from) session.callerPhone = opts.from;` and before `return { session, replayed: false };`:

```ts
    // #866 — resolve the caller to a tenant ACTOR once, here, for both
    // transports (this method is the shared establishment core). The shared
    // lookup dispatch authorises by the actor's DB role; the phone used to
    // carry only the ownerSession boolean. Fail-soft: never blocks the call.
    const actor = await resolvePhoneActor(
      { ...(this.deps.userRepo ? { userRepo: this.deps.userRepo } : {}) },
      opts.tenantId,
      opts.from,
      ownerSession,
    );
    if (actor) {
      session.actorUserId = actor.userId;
      // `via` is the one diagnostic an operator needs when an owner's
      // lookups behave differently from expected ("resolved through the
      // owner_phone bridge" vs "through a registered mobile"). No caller-ID
      // or user id in the log line.
      logger.info('phone actor resolved at session establishment', {
        tenantId: opts.tenantId,
        sessionId: session.id,
        via: actor.via,
      });
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/api && npx vitest run test/telephony/owner-session.test.ts test/telephony/phone-actor.test.ts`
Expected: PASS.

- [ ] **Step 5: Build check and commit**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd ../.. && git add packages/api/src/telephony/twilio-adapter.ts packages/api/test/telephony/owner-session.test.ts
git commit -m "feat(telephony): stamp actorUserId at inbound session establishment

Both transports pass through establishInboundSession, so media-streams
gets the actor for free when #860 step 2 lands."
```

- [ ] **Step 6 (from code review, 2026-08-26): close the suspended-approver fall-through**

A tenant user whose mobile MATCHES but who is suspended must resolve **no** actor even on the owner line — never fall through to the sole-owner bridge (a suspended backup supervisor's mobile is still an approver phone, so `ownerSession` is true, and the bridge would hand them the owner's identity). In `phone-actor.ts`: `if (byMobile) return isActive(byMobile) ? {…via:'mobile'} : null;` before the `ownerSession` check. Pin in both `phone-actor.test.ts` and the #866 describe of `owner-session.test.ts`. Also: give the file's old `stubUserRepo()` a `findByMobileNumber`/`findByTenant` so the RV-070 test stops exercising the fail-soft catch; assert `findByMobileNumber` is called once across a Twilio replay; add a `handleInboundForStream` case.

**Reviewed and closed without code:** the voice-quality drivers (`ai/voice-quality/text-mode-driver.ts`, `ai/voice-quality/audio/audio-mode-driver.ts`) create `ownerSession: true` telephony sessions without an actor. Verified they cannot reach the gate this plan flips: the text-mode driver runs its own private 15-case lookup switch (out of scope, see Task 10), and the audio driver rides media-streams, which dispatches no lookups until #860 step 2 — which must stamp `actorUserId` for the audio path when it lands. Recorded on `VoiceSession.actorUserId`'s doc comment.

---

### Task 3: Shared reference helper + the phone surface adapter (five dead lookups answer)

**Files:**
- Create: `packages/api/src/ai/orchestration/lookup-reference.ts`
- Modify: `packages/api/src/ai/orchestration/lookup-dispatch.ts` (delete its private `resolveReference`, import the shared one)
- Create: `packages/api/src/ai/voice-turn/phone-lookup-surface.ts`
- Modify: `packages/api/src/telephony/twilio-adapter.ts` (deps interface + lookup branch)
- Test: `packages/api/test/telephony/lookup-dispatch-characterization.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the characterization test to pin the NEW behaviour**

Replace the whole file with:

```ts
// packages/api/test/telephony/lookup-dispatch-characterization.test.ts
/**
 * The live-phone lookup path, pinned at the Gather seam (#866 / #843).
 *
 * History: PR #860 wrote this net to pin the OLD behaviour — including the
 * five intents that had no case and the ownerSession-only authorization —
 * so that fixing them "stays a deliberate act". This is that act. The phone
 * is now the third caller of the shared dispatch
 * (`workers/voice-lookup-answer.ts`), authorised by the session's ACTOR.
 *
 * Everything here is observable behaviour: what the caller hears, where the
 * FSM is left, what the session bus saw. Nothing asserts which internal
 * function ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';
import {
  LOOKUP_UNAVAILABLE_LINE,
} from '../../src/ai/voice-turn/phone-lookup-surface';

const tenantId = 'tenant-lk';
const NOT_WIRED = 'I&apos;m having trouble pulling that up right now';
const OWNER_REFUSAL = 'owner-level report';

function gatewayReturning(intentType: string, extractedEntities?: Record<string, unknown>): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96, ...(extractedEntities ? { extractedEntities } : {}) }),
    model: 'stub',
    provider: 'stub',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

type Role = 'owner' | 'dispatcher' | 'technician';

/**
 * A minimal lookups bundle. `answers`/`shared` mirror app.ts's shape; every
 * repo is a vi.fn stub the test controls. `roles` maps actorUserId → role for
 * the shared module's RBAC gate.
 */
function lookups(over: {
  answers?: Partial<PhoneLookupDeps['answers']>;
  shared?: Partial<PhoneLookupDeps['shared']>;
  roles?: Record<string, Role>;
  entityResolver?: PhoneLookupDeps['entityResolver'];
}): PhoneLookupDeps {
  return {
    answers: {
      resolveMemberRole: async (_t: string, userId: string) => over.roles?.[userId] ?? null,
      ...(over.answers ?? {}),
    } as PhoneLookupDeps['answers'],
    shared: {
      proposalRepo: { findByTenant: vi.fn(async () => []) },
      ...(over.shared ?? {}),
    } as unknown as PhoneLookupDeps['shared'],
    ...(over.entityResolver ? { entityResolver: over.entityResolver } : {}),
  };
}

function makeAdapter(opts: {
  intentType: string;
  entities?: Record<string, unknown>;
  ownerSession?: boolean;
  actorUserId?: string;
  identified?: boolean;
  lookups?: PhoneLookupDeps;
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(opts.intentType, opts.entities),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.lookups ? { lookups: opts.lookups } : {}),
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-${opts.intentType}-${opts.actorUserId ?? 'anon'}`;
  const session = store.create(tenantId, 'telephony', {
    callSid,
    ...(opts.ownerSession ? { ownerSession: true, extendedIntents: true } : {}),
  });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (opts.identified !== false) {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    session.customerId = 'cust-1';
  }
  const events: Array<{ type?: string; success?: boolean; error?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return { adapter, session, callSid, events };
}

const ask = (h: ReturnType<typeof makeAdapter>, speech: string) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    confidence: 0.95,
    tenantId,
  });

const lookupEvents = (h: ReturnType<typeof makeAdapter>) => h.events.filter((e) => e.type === 'lookup_executed');

describe('phone lookups — the five that were dead on the phone now answer', () => {
  it('lookup_my_day: a technician actor hears THEIR day (self-scoped through the shared dispatch)', async () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        shared: {
          appointmentRepo: {
            findByDateRange: vi.fn(async () => [
              { id: 'a1', tenantId, jobId: 'job-1', scheduledStart: start, scheduledEnd: new Date(start.getTime() + 3_600_000), status: 'scheduled' },
            ]),
          },
          jobRepo: {
            findByIds: vi.fn(async () => [{ id: 'job-1', tenantId, summary: 'Main drain repair', assignedTechnicianId: 'u-tech' }]),
          },
          userRepo: {
            findByTenant: vi.fn(async () => [{ id: 'u-tech', tenantId, clerkUserId: 'clerk-tech', role: 'technician' }]),
          },
        },
      }),
    });

    const xml = await ask(h, "what's my day look like");

    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Main drain repair');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(xml).toContain('Anything else');
  });

  it('lookup_materials: any resolved actor hears the pending shopping list', async () => {
    const listPending = vi.fn(async () => [
      { id: 'm1', tenantId, description: '3/4 inch copper elbows', quantity: 6, status: 'pending', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const h = makeAdapter({
      intentType: 'lookup_materials',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { materialItemRepo: { listPending } as never } }),
    });

    const xml = await ask(h, 'what materials do I need');

    expect(listPending).toHaveBeenCalled();
    expect(xml).toContain('copper elbows');
  });

  it('lookup_job_profit: an owner naming a job hears the margin', async () => {
    const findById = vi.fn(async () => ({ id: 'job-1', tenantId, summary: 'Miller water heater', status: 'completed' }));
    const h = makeAdapter({
      intentType: 'lookup_job_profit',
      entities: { jobReference: 'the Miller job' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: { resolve: vi.fn(async () => ({ kind: 'resolved', candidate: { id: 'job-1', kind: 'job', label: 'Miller water heater', score: 0.99 } })) },
        shared: { jobRepo: { findById, findByIds: vi.fn(async () => []) } },
        answers: {
          settingsRepo: { findByTenant: vi.fn(async () => ({ tenantId, laborRateCentsPerHour: 8500 })) } as never,
          invoiceRepo: { findByJob: vi.fn(async () => [{ id: 'inv-1', jobId: 'job-1', status: 'paid', totals: { totalCents: 120000 }, amountPaidCents: 120000, amountDueCents: 0 }]) } as never,
          timeEntryRepo: { findByJob: vi.fn(async () => []) } as never,
          expenseRepo: { findByJob: vi.fn(async () => []) } as never,
        },
      }),
    });

    const xml = await ask(h, 'did I make money on the Miller job');

    expect(findById).toHaveBeenCalledWith(tenantId, 'job-1');
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).not.toContain(OWNER_REFUSAL);
  });

  it.each(['lookup_crew_schedule', 'lookup_timesheets'])(
    '%s: a dispatcher actor is answered (reports:view) — the flag-era ownerSession gate is gone',
    async (intentType) => {
      const h = makeAdapter({
        intentType,
        actorUserId: 'clerk-dispatch',
        lookups: lookups({
          roles: { 'clerk-dispatch': 'dispatcher' },
          shared: {
            appointmentRepo: { findByDateRange: vi.fn(async () => []) },
            jobRepo: { findByIds: vi.fn(async () => []) },
            userRepo: { findByTenant: vi.fn(async () => []) },
          },
          answers: {
            timeEntryRepo: { listByTenant: vi.fn(async () => []), findByUser: vi.fn(async () => []), findByJob: vi.fn(async () => []) } as never,
          },
        }),
      });

      const xml = await ask(h, 'tell me about the crew');

      expect(xml).not.toContain(NOT_WIRED);
      expect(xml).not.toContain(OWNER_REFUSAL);
      expect(h.session.machine.currentState).toBe('intent_capture');
    },
  );
});

describe('phone lookups — authorization is the actor\'s DB role, not the caller-ID boolean', () => {
  it('a technician asking for revenue hears the owner-level refusal, and no repo is read', async () => {
    const getRevenue = vi.fn();
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { moneyDashboardRepo: { getRevenue } as never } }),
    });

    const xml = await ask(h, 'how much did we make this month');

    expect(xml).toContain(OWNER_REFUSAL);
    expect(getRevenue).not.toHaveBeenCalled();
  });

  it('an identified CUSTOMER (no actor) asking for revenue is refused — the defence-in-depth gap from #866', async () => {
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      lookups: lookups({ answers: { moneyDashboardRepo: { getRevenue: vi.fn() } as never } }),
    });

    const xml = await ask(h, 'how much money did you make this month');

    expect(xml).toContain(OWNER_REFUSAL);
  });

  it('an identified customer asking for the lead pipeline is refused honestly', async () => {
    const h = makeAdapter({
      intentType: 'lookup_leads',
      lookups: lookups({ answers: { leadRepo: { findByTenant: vi.fn(async () => []) } as never } }),
    });

    const xml = await ask(h, 'what leads do you have');

    expect(xml).toContain('couldn&apos;t verify your access to the lead pipeline');
  });

  it('an owner actor on a session with the tenant flag OFF is still answered — the flag gates classification, not dispatch', async () => {
    const findLatest = vi.fn(async () => ({ narrative: 'Owner digest: revenue was strong' }));
    const h = makeAdapter({
      intentType: 'lookup_digest',
      ownerSession: false,
      actorUserId: 'clerk-owner',
      lookups: lookups({ roles: { 'clerk-owner': 'owner' }, answers: { dailyDigestRepo: { findLatest } as never } }),
    });

    const xml = await ask(h, 'read me my digest');

    expect(findLatest).toHaveBeenCalled();
    expect(xml).toContain('Owner digest');
  });

  it('a customer\'s own balance / invoices / appointments keep answering exactly as before', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer, findById: vi.fn(async () => null) }, appointmentRepo: { findByCustomer: vi.fn(async () => []) } } }),
    });

    const xml = await ask(h, 'what jobs do I have open');

    expect(findByCustomer).toHaveBeenCalledWith(tenantId, 'cust-1');
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Anything else');
  });
});

describe('phone lookups — the contract that must not move', () => {
  it('an unidentified caller never reaches a lookup — identification intercepts first', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      identified: false,
      lookups: lookups({ shared: { jobRepo: { findByCustomer } } }),
    });

    await ask(h, 'what jobs do I have');

    expect(h.session.machine.currentState).toBe('identifying');
    expect(findByCustomer).not.toHaveBeenCalled();
  });

  it('a lookup never advances the FSM', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices', lookups: lookups({}) });
    await ask(h, 'what do I owe');
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('a deployment with no lookups bundle speaks the unavailable line (never a 5xx)', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices' });

    const xml = await ask(h, 'what do I owe');

    expect(xml).toContain(NOT_WIRED);
    expect(LOOKUP_UNAVAILABLE_LINE).toContain("I'm having trouble pulling that up right now");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && npx vitest run test/telephony/lookup-dispatch-characterization.test.ts`
Expected: FAIL — `Cannot find module '../../src/ai/voice-turn/phone-lookup-surface'`.

- [ ] **Step 3: Move `resolveReference` into a shared helper**

Create `packages/api/src/ai/orchestration/lookup-reference.ts`:

```ts
/**
 * The ONE free-text → verified-id helper the lookup surface adapters share
 * (assistant chat: `lookup-dispatch.ts`; live phone:
 * `ai/voice-turn/phone-lookup-surface.ts`). Read-only lookups accept the
 * `low_confidence` band — the voice WRITE path forces a confirm turn there
 * because it is about to mutate; reading an operator their own tenant's
 * probably-right record is not the same risk. `ambiguous` still asks.
 *
 * Lives here, not in either adapter, so a third surface adds a caller rather
 * than a third copy — the same rule the shared dispatch itself states.
 */
import type { EntityCandidate, EntityResolver } from '../resolution/entity-resolver';

export type LookupReferenceResult =
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; candidates: EntityCandidate[] }
  | { kind: 'unresolved' };

export async function resolveLookupReference(
  resolver: EntityResolver | undefined,
  tenantId: string,
  reference: string | undefined,
  kind: 'customer' | 'job' | 'technician',
): Promise<LookupReferenceResult> {
  if (!resolver || !reference || reference.trim().length === 0) return { kind: 'unresolved' };
  const result = await resolver.resolve({ tenantId, reference, kind });
  if (result.kind === 'resolved' || result.kind === 'low_confidence') {
    return { kind: 'resolved', id: result.candidate.id };
  }
  if (result.kind === 'ambiguous') return { kind: 'ambiguous', candidates: result.candidates };
  return { kind: 'unresolved' };
}

/** Spoken/typed "which one?" — shared copy so both surfaces ask the same way. */
export function ambiguousReferenceLine(reference: string, candidates: EntityCandidate[]): string {
  const list = candidates
    .slice(0, 5)
    .map((c) => c.label)
    .join('; ');
  return `More than one match for "${reference}": ${list}. Which one did you mean?`;
}
```

In `packages/api/src/ai/orchestration/lookup-dispatch.ts`:
- Add `import { resolveLookupReference, ambiguousReferenceLine } from './lookup-reference';`
- Delete the private `async function resolveReference(...)` (the block whose doc comment begins "Resolve one free-text reference").
- Replace the three `resolveReference(` calls in `dispatchAssistantLookup` with `resolveLookupReference(` (same arguments).
- In `ambiguousReply`, replace the `const list = ...` + `content:` template with `content: ambiguousReferenceLine(reference, candidates),` and delete the now-unused `list` variable.
- `EntityCandidate` is still used by `ambiguousReply`'s signature; keep that import.

Run `npx vitest run test/routes/assistant-lookup-dispatch.test.ts` — must still PASS (chat behaviour unchanged).

- [ ] **Step 4: Write the phone surface adapter**

```ts
// packages/api/src/ai/voice-turn/phone-lookup-surface.ts
/**
 * Lookup surface adapter for the LIVE PHONE (#866, closes #843).
 *
 * THE SEAM
 * --------
 * This module contains NO lookup switch. It is the phone's thin caller of
 * `workers/voice-lookup-answer.ts#executeLookupAnswer` — the one per-skill
 * dispatch the recorded-memo worker and the assistant chat already use. The
 * phone used to carry its own 14-case copy (`lookup-skill-runner.ts`, now
 * deleted); five intents had no case and answered "let me get a person",
 * and nothing fired a metric. Adding a surface means adding a caller, NOT
 * copying the switch.
 *
 * What lives here (and ONLY here) is genuinely phone-specific:
 *   1. Identity. The caller IS the customer for customer-scoped lookups
 *      (`session.customerId` from caller-ID identification), and the
 *      ACTOR is `session.actorUserId`, resolved once at session
 *      establishment (`telephony/phone-actor.ts`). The shared module's
 *      RBAC gate does the authorising — there is no ownerSession /
 *      extendedIntents check at dispatch any more. The tenant flag still
 *      decides whether the classifier OFFERS the owner-extended intents;
 *      that is a prompt-hash concern, and this is defence in depth behind it.
 *   2. Reference resolution. Job / crew-member / day references the
 *      classifier extracted go through the SAME shared resolver chat uses
 *      (`lookup-reference.ts`). A spoken customer NAME is deliberately not
 *      resolved here — on the phone the caller is the customer; an owner
 *      asking about a customer by name is the map's open "entity resolution
 *      per surface" question and lands in this file if/when decided.
 *   3. Response shape + failure copy. The answer's `summary` is already the
 *      TTS-ready sentence; refusals are spoken as-is. `failed` and
 *      `unsupported` speak LOOKUP_UNAVAILABLE_LINE — and `unsupported` on the
 *      phone is a deployment wiring gap, so it also logs.
 *   4. Telemetry. `lookup_executed` on the session bus for EVERY outcome
 *      (answered / refused / failed / unsupported / ambiguous), so a dead
 *      lookup is a metric, not an audit finding.
 *
 * TRANSPORT-NEUTRAL BY DESIGN. Input is a session + intent + entities; output
 * is a line to speak. Gather calls it today; media-streams' `speechTurn` calls
 * the same function when #860 step 2 lands (held on #838 Q2). Nothing here
 * knows which transport it serves.
 *
 * FSM CONTRACT (unchanged). The CALLER must not dispatch `intent_classified`
 * for a lookup — the turn stays in `intent_capture` so the next utterance can
 * be another question.
 */
import { createLogger } from '../../logging/logger';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import type { IntentType } from '../orchestration/intent-classifier';
import { TECHNICIAN_REF_INTENTS } from '../agents/customer-calling/entity-resolution';
import { ambiguousReferenceLine, resolveLookupReference } from '../orchestration/lookup-reference';
import type { EntityResolver } from '../resolution/entity-resolver';
import { lookupExecutedEvent } from '../voice-quality/events';
import {
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  executeLookupAnswer,
  type SharedLookupRepos,
  type VoiceLookupAnswerDeps,
} from '../../workers/voice-lookup-answer';

/** Same shape as the chat adapter's bundle — app.ts builds ONE and hands it to every surface. */
export interface PhoneLookupDeps {
  answers: VoiceLookupAnswerDeps;
  shared: SharedLookupRepos;
  entityResolver?: EntityResolver;
  /** Tenant IANA timezone for spoken dates; failure-soft. */
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface PhoneLookupInput {
  session: VoiceSession;
  tenantId: string;
  intent: IntentType;
  /** The classifier's extractedEntities for this turn (may be empty). */
  entities?: Record<string, unknown>;
}

/** Spoken when the skill failed, the deployment lacks the repos, or no bundle is wired. Unchanged from the old runner. */
export const LOOKUP_UNAVAILABLE_LINE =
  "I'm having trouble pulling that up right now. Let me get a person to help.";
/** Spoken for a customer-scoped ask from a caller identification never resolved. Unchanged from the old runner. */
export const UNIDENTIFIED_CALLER_LINE =
  "I can't pull up your account without identifying you first. Let me get a person to help.";

const logger = createLogger({
  service: 'voice.phone-lookup-surface',
  environment: process.env.NODE_ENV || 'development',
});

function str(entities: Record<string, unknown>, key: string): string | undefined {
  const v = entities[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

export async function answerPhoneLookup(
  deps: PhoneLookupDeps | undefined,
  input: PhoneLookupInput,
): Promise<string> {
  const { session, tenantId, intent } = input;
  const entities = input.entities ?? {};
  const startMs = Date.now();
  const emit = (success: boolean, error?: string) =>
    session.events.emit('voice-event', lookupExecutedEvent(intent, Date.now() - startMs, success, error));

  if (!deps) {
    logger.warn('phone lookup requested but no lookups bundle is wired — deployment wiring gap', {
      tenantId,
      sessionId: session.id,
      intent,
    });
    emit(false, 'unsupported');
    return LOOKUP_UNAVAILABLE_LINE;
  }

  try {
    const customerId = session.customerId;
    if (CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent) && !customerId) {
      // Defensive — the FSM holds the turn in `identifying` before the lookup
      // branch is reached, so this is normally unreachable. Never leak a
      // different tenant's summary to an anonymous caller.
      emit(false, 'unidentified_caller');
      return UNIDENTIFIED_CALLER_LINE;
    }

    const jobReference = str(entities, 'jobReference');
    const technicianReference = TECHNICIAN_REF_INTENTS.has(intent)
      ? str(entities, 'targetTechnicianName')
      : undefined;
    const dateTimeDescription = str(entities, 'dateTimeDescription');

    let jobId: string | undefined;
    if (jobReference) {
      const r = await resolveLookupReference(deps.entityResolver, tenantId, jobReference, 'job');
      if (r.kind === 'ambiguous') {
        emit(false, 'ambiguous_reference');
        return ambiguousReferenceLine(jobReference, r.candidates);
      }
      if (r.kind === 'resolved') jobId = r.id;
    }

    let technicianId: string | undefined;
    if (technicianReference) {
      const r = await resolveLookupReference(deps.entityResolver, tenantId, technicianReference, 'technician');
      if (r.kind === 'ambiguous') {
        emit(false, 'ambiguous_reference');
        return ambiguousReferenceLine(technicianReference, r.candidates);
      }
      if (r.kind === 'resolved') technicianId = r.id;
    }

    const timezone = deps.tenantTimezoneResolver
      ? await deps.tenantTimezoneResolver(tenantId).catch(() => undefined)
      : undefined;

    const execution = await executeLookupAnswer(
      {
        tenantId,
        // Voice session ids are UUIDs — lookup_events.session_id is a UUID column.
        sessionId: session.id,
        intent,
        ...(session.actorUserId ? { actorId: session.actorUserId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(jobReference ? { jobReference } : {}),
        ...(technicianId ? { technicianId } : {}),
        ...(technicianReference ? { technicianReference } : {}),
        ...(dateTimeDescription ? { dateTimeDescription } : {}),
        ...(timezone ? { timezone } : {}),
        now: deps.now ? deps.now() : new Date(),
      },
      deps.answers,
      deps.shared,
    );

    if (execution.kind === 'unsupported') {
      logger.warn('phone lookup unsupported — the shared dispatch has no wired skill for this intent in this deployment', {
        tenantId,
        sessionId: session.id,
        intent,
      });
      emit(false, 'unsupported');
      return LOOKUP_UNAVAILABLE_LINE;
    }
    if (execution.kind === 'failed') {
      logger.warn('phone lookup failed', { tenantId, sessionId: session.id, intent, error: execution.error });
      emit(false, execution.error);
      return LOOKUP_UNAVAILABLE_LINE;
    }
    // 'found' | 'none' | 'refused' all carry a data-derived, TTS-ready summary.
    emit(execution.answer.result !== 'refused', execution.answer.result === 'refused' ? 'refused' : undefined);
    return execution.answer.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('phone lookup threw outside the shared dispatch (resolver / timezone)', {
      tenantId,
      sessionId: session.id,
      intent,
      error: message,
    });
    emit(false, message);
    return LOOKUP_UNAVAILABLE_LINE;
  }
}
```

- [ ] **Step 5: Wire the adapter to it**

In `packages/api/src/telephony/twilio-adapter.ts`:

1. Replace the import `import { runLookupSkill } from '../ai/voice-turn/lookup-skill-runner';` with:
   ```ts
   import { answerPhoneLookup, type PhoneLookupDeps } from '../ai/voice-turn/phone-lookup-surface';
   ```
2. In `export interface TwilioAdapterDeps`, add after `lookupEvents?: LookupEventService;`:
   ```ts
     /**
      * #866 — the SAME lookup bundle (answers + shared repos + resolver +
      * timezone) app.ts hands the memo worker and the assistant chat. The
      * phone's read-only `lookup_*` intents dispatch through it
      * (`ai/voice-turn/phone-lookup-surface.ts`). Absent → every lookup speaks
      * the unavailable line and logs a wiring-gap warning.
      */
     lookups?: PhoneLookupDeps;
   ```
3. Replace the lookup branch body (the block beginning `const lookupSummary = await runLookupSkill(` through the closing `);` of that call) with:
   ```ts
           const lookupSummary = await answerPhoneLookup(this.deps.lookups, {
             session,
             tenantId: opts.tenantId,
             intent: classifiedIntentType as IntentType,
             entities:
               classifierEvent && classifierEvent.type === 'intent_classified'
                 ? classifierEvent.entities
                 : {},
           });
   ```
   `IntentType` — check it is already imported in this file (`grep -n "IntentType" src/telephony/twilio-adapter.ts | head -3`); if not, add `import type { IntentType } from '../ai/orchestration/intent-classifier';`.
4. Update the comment above the branch: replace `// P11-001: lookup intents bypass the proposal-draft path. Route
   // to the corresponding skill, push its \`summary\` into the` with `// P11-001 / #866: lookup intents bypass the proposal-draft path. Route
   // through the shared dispatch (phone surface adapter), push the line into the`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/api && npx vitest run test/telephony/lookup-dispatch-characterization.test.ts test/routes/assistant-lookup-dispatch.test.ts`
Expected: PASS. If a skill-shape stub in a test is wrong (e.g. a repo method name the shared case actually calls), fix the STUB to the method the shared module calls (read `workers/voice-lookup-answer.ts`'s case for that intent) — do not change production code to fit a stub.

Note: `test/telephony/lookup-catalog-owner-gate.test.ts` and the owner block in `twilio-adapter.test.ts` are now RED (they pass repos directly and expect the old gate). That is expected; Task 4 fixes them. Do not commit with them red — Tasks 3 and 4 are one commit. Continue to Task 4.

- [ ] **Step 7 (decision taken during execution, 2026-08-26): owner-extended intents require a resolved actor on the phone**

`lookup_day_overview` has no entry in `LOOKUP_REQUIRED_PERMISSION` (any signed-in operator may hear it on memo/chat), so routing the phone through the shared gate alone would let a caller with NO actor hear the tenant's day overview — a regression from the old `ownerSession` gate. The classifier's own contract for `OWNER_EXTENDED_LOOKUP_INTENT_TYPES` is "never enabled for anonymous customers", and the phone is the only surface with anonymous/customer callers. So the phone surface adapter refuses any intent in that set when `session.actorUserId` is absent, speaking the shared module's own refusal copy (`refusalSummary(intent)`, now exported) and emitting `lookup_executed` with `error: 'refused'`. Memo/chat semantics are unchanged (a technician actor still hears the day overview). Pinned in the characterization suite and the Task 4 `twilio-adapter.test.ts` no-actor cases (all three owner-extended intents → `owner-level report`). Also: the `lookup_my_day` pin uses an injected fixed clock (`PhoneLookupDeps.now`) so it cannot flake near local midnight.

---

### Task 4: Re-pin the catalog gate and the owner-lookup block on the actor's role

**Files:**
- Modify: `packages/api/test/telephony/lookup-catalog-owner-gate.test.ts`
- Modify: `packages/api/test/telephony/twilio-adapter.test.ts` (the `ownerAdapter` block, ~lines 1073–1233)

- [ ] **Step 1: Rewrite `lookup-catalog-owner-gate.test.ts`**

Replace the header comment and `makeAdapter` + the `describe` with:

```ts
/**
 * WS5 → #866 — `lookup_catalog` is gated on the ACTOR's role (`settings:view`:
 * owners and dispatchers), not on the caller-ID boolean.
 *
 * Before WS5 any identified caller could browse the price book. WS5 gated it
 * on `ownerSession`. #866 routes the phone through the shared dispatch, whose
 * RBAC gate mirrors the web route (GET /api/catalog-items): an owner or
 * dispatcher actor hears the catalog; a customer (no actor) or a technician
 * hears the office-level refusal and the repo is never read. Customer price
 * questions still flow through the grounded estimate path.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { CatalogItem, CatalogItemRepository } from '../../src/catalog/catalog-item';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';

const tenantId = 'tenant-cat';

function gatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function catalogItem(name: string, unitPriceCents: number): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name}`,
    tenantId,
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeAdapter(actor?: { userId: string; role: 'owner' | 'dispatcher' | 'technician' }) {
  const store = new VoiceSessionStore({ startInterval: false });
  const listByTenant = vi.fn(async () => [
    catalogItem('Water Heater Replacement', 185000),
    catalogItem('Gasket', 450),
  ]);
  const catalogRepo = { listByTenant } as unknown as CatalogItemRepository;
  const lookups: PhoneLookupDeps = {
    answers: {
      catalogRepo,
      resolveMemberRole: async (_t, userId) => (actor && userId === actor.userId ? actor.role : null),
    },
    shared: { proposalRepo: { findByTenant: vi.fn(async () => []) } as never },
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(JSON.stringify({ intentType: 'lookup_catalog', confidence: 0.96 })),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    lookups,
  });
  const callSid = `CA-cat-${actor?.role ?? 'cust'}`;
  const session = store.create(tenantId, 'telephony', { callSid });
  if (actor) session.actorUserId = actor.userId;
  session.machine.dispatch({ type: 'incoming_call', tenantId, callSid, from: '+15125550111', to: '+15125550000' });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  // Even an identified CUSTOMER must not browse the catalog.
  session.customerId = 'cust-1';
  return { adapter, session, callSid, listByTenant };
}

const ask = (h: ReturnType<typeof makeAdapter>) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: "what's in our catalog",
    confidence: 0.95,
    tenantId,
  });

describe('lookup_catalog — gated on the actor\'s role (settings:view)', () => {
  it.each(['owner', 'dispatcher'] as const)('a %s actor hears the catalog summary', async (role) => {
    const h = makeAdapter({ userId: `clerk-${role}`, role });
    const xml = await ask(h);
    expect(xml).toContain('catalog items');
    expect(xml).toContain('Water Heater Replacement');
    expect(h.listByTenant).toHaveBeenCalled();
  });

  it('a technician actor is refused with the office-level copy and the repo is never read', async () => {
    const h = makeAdapter({ userId: 'clerk-tech', role: 'technician' });
    const xml = await ask(h);
    expect(xml).toContain('office-level view');
    expect(xml).not.toContain('Water Heater Replacement');
    expect(h.listByTenant).not.toHaveBeenCalled();
  });

  it('an identified customer (no actor) is refused and never reads the catalog', async () => {
    const h = makeAdapter();
    const xml = await ask(h);
    expect(xml).toContain('office-level view');
    expect(xml).not.toContain('Water Heater Replacement');
    expect(h.listByTenant).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rewrite the `ownerAdapter` block in `twilio-adapter.test.ts`**

Replace the `ownerAdapter` helper and the three tests that follow it (through the `flag-off owner session refuses…` test) with:

```ts
    async function ownerAdapter(
      intentType: string,
      actor: { userId: string; role: 'owner' | 'dispatcher' | 'technician' } | null = { userId: 'clerk-owner', role: 'owner' },
      extendedIntents = true,
    ) {
      const store = new VoiceSessionStore();
      const gateway = makeGatewayReturning(JSON.stringify({ intentType, confidence: 0.96 }));
      const appointmentRepo = new InMemoryAppointmentRepository();
      const jobRepo = new InMemoryJobRepository();
      const proposalRepo = new InMemoryProposalRepository();
      const dailyDigestRepo = new InMemoryDailyDigestRepository();
      const estimateRepo = new InMemoryEstimateRepository();
      const invoiceRepo = new InMemoryInvoiceRepository();
      const droppedCallRecoveryRepo = new InMemoryDroppedCallRecoveryRepository();
      const adapter = new TwilioGatherAdapter({
        store,
        gateway,
        businessName: 'Acme Plumbing',
        publicBaseUrl: 'https://example.com',
        appointmentRepo,
        jobRepo,
        proposalRepo,
        estimateRepo,
        invoiceRepo,
        // #866 — lookups dispatch through the shared bundle, the same shape
        // app.ts hands memo + chat. Authorization is the actor's role.
        lookups: {
          answers: {
            dailyDigestRepo,
            estimateRepo,
            invoiceRepo,
            droppedCallRecoveryRepo,
            resolveMemberRole: async (_t, userId) => (actor && userId === actor.userId ? actor.role : null),
          },
          shared: { appointmentRepo, jobRepo, proposalRepo },
        },
      });
      const session = store.create(tenantId, 'telephony', {
        callSid: `CA-${intentType}`,
        ...(actor?.role === 'owner' ? { ownerSession: true } : {}),
        ...(extendedIntents ? { extendedIntents: true } : {}),
      });
      if (actor) session.actorUserId = actor.userId;
      advanceToIntentCapture(session);
      return {
        adapter,
        session,
        appointmentRepo,
        jobRepo,
        proposalRepo,
        dailyDigestRepo,
        estimateRepo,
        invoiceRepo,
        droppedCallRecoveryRepo,
      };
    }
```

Keep the first `it.each([...])('owner session dispatches %s without a customerId and speaks the summary', …)` test exactly as it is (it calls `ownerAdapter(intentType)` — the default actor is an owner).

Replace the second test with:

```ts
    it.each(['lookup_day_overview', 'lookup_digest', 'lookup_pending_items'])(
      'a session with NO actor (customer line) is refused %s — day overview speaks the unavailable line, the permission-gated two speak the owner-level refusal',
      async (intentType) => {
        const deps = await ownerAdapter(intentType, null);
        const xml = await deps.adapter.handleGather({
          sessionId: deps.session.id,
          callSid: `CA-${intentType}-non-owner`,
          speechResult: 'owner lookup please',
          confidence: 0.95,
          tenantId,
        });

        if (intentType === 'lookup_day_overview') {
          // No permission entry — but the shared dispatch needs the roster and
          // no userRepo is wired here, so it degrades to unavailable. Either
          // way: no digest, no pending items, no data.
          expect(xml).toContain('I&apos;m having trouble pulling that up right now');
        } else {
          expect(xml).toContain('owner-level report');
        }
        expect(xml).not.toContain('Owner digest: revenue was strong');
      },
    );
```

Replace the `flag-off owner session refuses a forced lookup_digest…` test with these two:

```ts
    it('a forced lookup_digest classification with NO resolvable actor is refused without calling the skill', async () => {
      const deps = await ownerAdapter('lookup_digest', null, false);
      const findLatest = vi.spyOn(deps.dailyDigestRepo, 'findLatest');

      const xml = await deps.adapter.handleGather({
        sessionId: deps.session.id,
        callSid: 'CA-lookup_digest-no-actor',
        speechResult: 'read me my day',
        confidence: 0.95,
        tenantId,
      });

      expect(xml).toContain('owner-level report');
      expect(findLatest).not.toHaveBeenCalled();
    });

    it('the extendedIntents flag no longer gates DISPATCH: a flag-off owner actor is answered (the flag gates classification only)', async () => {
      const deps = await ownerAdapter('lookup_digest', { userId: 'clerk-owner', role: 'owner' }, false);
      await deps.dailyDigestRepo.upsert(
        tenantId,
        new Date().toISOString().slice(0, 10),
        {} as Parameters<InMemoryDailyDigestRepository['upsert']>[2],
        'Owner digest: revenue was strong',
      );

      const xml = await deps.adapter.handleGather({
        sessionId: deps.session.id,
        callSid: 'CA-lookup_digest-flag-off-owner-actor',
        speechResult: 'read me my day',
        confidence: 0.95,
        tenantId,
      });

      expect(xml).toContain('Owner digest: revenue was strong');
    });
```

Check the `lookup_day_overview` row of the first `it.each`: the shared dispatch's `lookup_day_overview` case needs `shared.appointmentRepo`, `shared.jobRepo`, `shared.proposalRepo` (and uses `shared.userRepo` if present). If it comes back unavailable, add `userRepo: new InMemoryUserRepository()` to `shared` (import from `../../src/users/user`) — read the case body in `workers/voice-lookup-answer.ts` to confirm what it requires rather than guessing.

- [ ] **Step 3: Run the telephony + assistant suites**

Run: `cd packages/api && npx vitest run test/telephony test/routes/assistant-lookup-dispatch.test.ts test/workers/voice-lookup-answer.test.ts`
Expected: PASS.

- [ ] **Step 4: Build check and commit (Tasks 3 + 4 together)**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd ../.. && git add packages/api/src/ai/orchestration/lookup-reference.ts packages/api/src/ai/orchestration/lookup-dispatch.ts packages/api/src/ai/voice-turn/phone-lookup-surface.ts packages/api/src/telephony/twilio-adapter.ts packages/api/test/telephony/lookup-dispatch-characterization.test.ts packages/api/test/telephony/lookup-catalog-owner-gate.test.ts packages/api/test/telephony/twilio-adapter.test.ts
git commit -m "feat(voice): route the live phone's lookups through the shared dispatch, authorised by the actor's role

Closes the #843 gap: lookup_my_day / lookup_materials / lookup_job_profit /
lookup_crew_schedule / lookup_timesheets answer on the phone. Authorization is
the shared module's RBAC gate on session.actorUserId — the ownerSession +
extendedIntents dispatch gate is gone (the flag still gates classification).
Also closes the defence-in-depth gap where an identified customer could hear
lookup_revenue / lookup_leads. Reference resolution moves to a shared helper.
Characterization pins from #860 flipped deliberately."
```

---

### Task 5: Spoken ambiguity and not-found for job / crew-member references

**Files:**
- Test: `packages/api/test/telephony/lookup-dispatch-characterization.test.ts` (append a `describe`)
- Modify: nothing expected — Task 3's adapter already implements it; this task PROVES it at the seam. If a test fails, fix `phone-lookup-surface.ts`.

- [ ] **Step 1: Append the tests**

```ts
describe('phone lookups — spoken reference resolution (shared resolver, chat semantics)', () => {
  it('an ambiguous job reference asks "which one?" listing the candidates, and stays in intent_capture', async () => {
    const h = makeAdapter({
      intentType: 'lookup_job_profit',
      entities: { jobReference: 'the Miller job' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: {
          resolve: vi.fn(async () => ({
            kind: 'ambiguous',
            candidates: [
              { id: 'j1', kind: 'job', label: 'Miller — Oak Street water heater', score: 0.8 },
              { id: 'j2', kind: 'job', label: 'Miller — 5th Ave furnace', score: 0.79 },
            ],
          })),
        },
        shared: { jobRepo: { findById: vi.fn(), findByIds: vi.fn(async () => []) } },
        answers: {
          settingsRepo: { findByTenant: vi.fn(async () => ({ tenantId })) } as never,
          invoiceRepo: { findByJob: vi.fn(async () => []) } as never,
          timeEntryRepo: { findByJob: vi.fn(async () => []) } as never,
          expenseRepo: { findByJob: vi.fn(async () => []) } as never,
        },
      }),
    });

    const xml = await ask(h, 'did I make money on the Miller job');

    expect(xml).toContain('More than one match for &quot;the Miller job&quot;');
    expect(xml).toContain('Oak Street');
    expect(xml).toContain('5th Ave');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ success: false, error: 'ambiguous_reference' })]);
  });

  it('a crew-member reference the resolver cannot find speaks the shared not-found copy', async () => {
    const h = makeAdapter({
      intentType: 'lookup_crew_schedule',
      entities: { targetTechnicianName: 'Jake' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: { resolve: vi.fn(async () => ({ kind: 'not_found', reference: 'Jake' })) },
        shared: {
          appointmentRepo: { findByDateRange: vi.fn(async () => []) },
          jobRepo: { findByIds: vi.fn(async () => []) },
          userRepo: { findByTenant: vi.fn(async () => []) },
        },
      }),
    });

    const xml = await ask(h, "what's Jake doing Thursday");

    expect(xml).toContain('couldn&apos;t find a crew member matching &quot;Jake&quot;');
  });

  it('a technician name on lookup_my_day is IGNORED (not a TECHNICIAN_REF intent) — the speaker is always self', async () => {
    const resolve = vi.fn();
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      entities: { targetTechnicianName: 'Jake' },
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        entityResolver: { resolve },
        shared: {
          appointmentRepo: { findByDateRange: vi.fn(async () => []) },
          jobRepo: { findByIds: vi.fn(async () => []) },
          userRepo: { findByTenant: vi.fn(async () => [{ id: 'u-tech', tenantId, clerkUserId: 'clerk-tech', role: 'technician' }]) },
        },
      }),
    });

    await ask(h, "what's my day look like");

    expect(resolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run**

Run: `cd packages/api && npx vitest run test/telephony/lookup-dispatch-characterization.test.ts`
Expected: PASS. (If the XML-escaping of quotes differs — `&quot;` vs `"` — inspect the actual output once and pin whatever `finalizeTwiml` produces; the copy itself must match `ambiguousReferenceLine`.)

- [ ] **Step 3: Commit**

```bash
git add packages/api/test/telephony/lookup-dispatch-characterization.test.ts
git commit -m "test(voice): pin spoken ambiguity / not-found for phone lookup references"
```

---

### Task 6: Telemetry on every outcome + the unsupported wiring-gap warning

**Files:**
- Test: `packages/api/test/telephony/lookup-dispatch-characterization.test.ts` (append a `describe`)

- [ ] **Step 1: Append the tests**

```ts
describe('phone lookups — every outcome is a lookup_executed event', () => {
  it('answered → success: true', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => []), findById: vi.fn(async () => null) }, appointmentRepo: { findByCustomer: vi.fn(async () => []) } } }),
    });
    await ask(h, 'what jobs do I have');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_jobs', success: true })]);
  });

  it('refused → success: false, error: refused', async () => {
    const h = makeAdapter({ intentType: 'lookup_revenue', lookups: lookups({ answers: { moneyDashboardRepo: {} as never } }) });
    await ask(h, 'revenue');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_revenue', success: false, error: 'refused' })]);
  });

  it('skill failure → success: false with the error, and the unavailable line', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => { throw new Error('pg down'); }), findById: vi.fn() }, appointmentRepo: {} } }),
    });
    const xml = await ask(h, 'what jobs do I have');
    expect(xml).toContain(NOT_WIRED);
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ success: false, error: 'pg down' })]);
  });

  it('unsupported (repos missing in this deployment) → success: false, error: unsupported, and a warning naming the intent', async () => {
    const { createLogger } = await import('../../src/logging/logger');
    const warn = vi.spyOn(createLogger({ service: 'probe', environment: 'test' }).constructor.prototype, 'warn');
    const h = makeAdapter({ intentType: 'lookup_materials', actorUserId: 'clerk-tech', lookups: lookups({ roles: { 'clerk-tech': 'technician' } }) });

    const xml = await ask(h, 'what materials do I need');

    expect(xml).toContain(NOT_WIRED);
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_materials', success: false, error: 'unsupported' })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported'), expect.objectContaining({ intent: 'lookup_materials' }));
    warn.mockRestore();
  });
});
```

If the logger is not a class with a shared prototype (check `src/logging/logger.ts`), replace the `warn` spy with the pattern this repo's other tests use to assert a log line — `grep -rn "spyOn(.*'warn')" packages/api/test | head -3` — and keep the assertion on the message + `{ intent }`.

- [ ] **Step 2: Run**

Run: `cd packages/api && npx vitest run test/telephony/lookup-dispatch-characterization.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api/test/telephony/lookup-dispatch-characterization.test.ts
git commit -m "test(voice): every phone lookup outcome emits lookup_executed; unsupported logs the wiring gap"
```

---

### Task 7: Delete the runner, drop the lookup-only adapter deps, wire `app.ts` (one bundle, three surfaces)

**Files:**
- Delete: `packages/api/src/ai/voice-turn/lookup-skill-runner.ts`
- Modify: `packages/api/src/telephony/twilio-adapter.ts` (`TwilioAdapterDeps`)
- Modify: `packages/api/src/workers/voice-lookup-answer.ts` (`droppedCallRecoveryRepo` for pending items; header)
- Modify: `packages/api/src/app.ts` (~lines 2532–2548, 3441–3520, 5478–5500)
- Test: `packages/api/test/workers/voice-lookup-answer.test.ts` (append)

- [ ] **Step 1: Failing test — pending items keep the recoveries line on every surface**

The phone's old switch passed `listUnansweredRecoveries` to `lookupPendingItems`; the shared case does not, so routing the phone through it would silently drop that line. Bring the shared module up instead. Append to `packages/api/test/workers/voice-lookup-answer.test.ts` (reuse the file's existing imports / helpers for `executeLookupAnswer`; add `vi` to the vitest import if missing):

```ts
describe('executeLookupAnswer — lookup_pending_items threads dropped-call recoveries when the repo is wired (#866 parity)', () => {
  it('passes listUnansweredRecoveries through to the skill', async () => {
    const listUnansweredRecoveries = vi.fn(async () => []);
    const execution = await executeLookupAnswer(
      { tenantId: 't1', sessionId: '00000000-0000-4000-8000-000000000001', intent: 'lookup_pending_items', actorId: 'owner-1', now: new Date() },
      {
        estimateRepo: { findByTenant: vi.fn(async () => []), findPendingByTenant: vi.fn(async () => []) } as never,
        invoiceRepo: { findByTenant: vi.fn(async () => []), findOpenByTenant: vi.fn(async () => []) } as never,
        droppedCallRecoveryRepo: { listUnansweredRecoveries },
        resolveMemberRole: async () => 'owner',
      },
      { proposalRepo: { findByTenant: vi.fn(async () => []) } as never },
    );

    expect(execution.kind).toBe('answer');
    expect(listUnansweredRecoveries).toHaveBeenCalledWith('t1');
  });
});
```

Read `src/ai/skills/lookup-pending-items.ts` to confirm which estimate/invoice repo methods it calls and stub those names (the two `findPendingByTenant` / `findOpenByTenant` guesses above are placeholders for you to replace with the real method names — this is the one place in this plan where you must look before pasting).

Run: `cd packages/api && npx vitest run test/workers/voice-lookup-answer.test.ts`
Expected: the new test FAILS — `listUnansweredRecoveries` not called (and a TS excess-property complaint on `droppedCallRecoveryRepo`).

- [ ] **Step 2: Add the dep to the shared module**

In `packages/api/src/workers/voice-lookup-answer.ts`:
- Add `import type { DroppedCallRecoveryRepository } from '../sms/recovery/scheduler';` with the other type imports.
- In `export interface VoiceLookupAnswerDeps`, after `dunningConfigRepo?: DunningConfigRepository;`:
  ```ts
    /**
     * #866 — dropped-call recoveries awaiting an answer, spoken by
     * `lookup_pending_items`. The phone's old switch passed this and the
     * memo/chat path did not; now every surface gets the same line.
     */
    droppedCallRecoveryRepo?: Pick<DroppedCallRecoveryRepository, 'listUnansweredRecoveries'>;
  ```
- In the `case 'lookup_pending_items'` block, inside the deps object passed to `lookupPendingItems`, after the `dunningConfigRepo` spread:
  ```ts
              ...(deps.droppedCallRecoveryRepo
                ? {
                    listUnansweredRecoveries: (tenant: string) =>
                      deps.droppedCallRecoveryRepo!.listUnansweredRecoveries(tenant),
                  }
                : {}),
  ```
- Header: change `SURFACE-NEUTRAL (2026-07): this switch is now the single lookup-dispatch implementation behind TWO surfaces — the recorded-memo worker (...) and the in-app assistant chat (...)` to `SURFACE-NEUTRAL: this switch is the single lookup-dispatch implementation behind THREE surfaces — the recorded-memo worker (\`workers/voice-action-router.ts\`), the in-app assistant chat (\`routes/assistant.ts\` via \`ai/orchestration/lookup-dispatch.ts\`), and, since #866, the live phone (\`ai/voice-turn/phone-lookup-surface.ts\`, both transports via the Gather adapter today).` Keep the rest of the paragraph.

Run the test again — PASS.

- [ ] **Step 3: Delete the runner and the lookup-only adapter deps**

```bash
git rm packages/api/src/ai/voice-turn/lookup-skill-runner.ts
grep -rn "lookup-skill-runner\|runLookupSkill" packages/api/src packages/api/test docs --include='*.ts' --include='*.md' | grep -v "text-mode-driver\|docs/superpowers/plans"
```
The grep must return only historical mentions in `docs/reference/voice-action-catalog.md` (fixed in Task 9) and `docs/decisions.md`/solutions prose. `text-mode-driver.ts`'s own private `runLookupSkill` (the voice-quality harness) is out of scope — leave it.

In `TwilioAdapterDeps` (`twilio-adapter.ts`), delete these five fields and their doc comments — nothing in the adapter or the voice-turn processor reads them (verified by grep before this plan): `moneyDashboardRepo`, `dailyDigestRepo`, `dunningConfigRepo`, `droppedCallRecoveryRepo`, `availabilityFinder`. Delete the now-unused type imports (`MoneyDashboardRepository`, `DailyDigestRepository`, `DunningConfigRepository`, `DroppedCallRecoveryRepository`, `AvailabilityFinder`) if nothing else in the file uses them (`grep -c` each).

- [ ] **Step 4: Wire `app.ts`**

Directly after the `const lookupAnswerDeps = { ... };` block (~line 2532–2548), add:

```ts
  // #866 — the repos the lookup skills reuse from the routers, built ONCE.
  // Handed to the assistant chat and the live phone as the same object, so
  // three surfaces cannot drift on which repos a skill gets. (The memo worker
  // assembles the identical set from its own deps inside voice-action-router.)
  const sharedLookupRepos = {
    jobRepo,
    appointmentRepo,
    customerRepo,
    proposalRepo,
    availabilityFinder,
    userRepo,
  };
  const phoneLookupDeps = {
    answers: lookupAnswerDeps,
    shared: sharedLookupRepos,
    ...(sharedEntityResolver ? { entityResolver: sharedEntityResolver } : {}),
    tenantTimezoneResolver: async (tenantId: string) =>
      (await tenantSchedulingResolver(tenantId))?.timezone,
  };
```

Add `droppedCallRecoveryRepo,` inside `lookupAnswerDeps` (after `dunningConfigRepo,`) — confirm the binding name with `grep -n "droppedCallRecoveryRepo" packages/api/src/app.ts` (it is already passed to the adapter today, so it exists above this point).

In `twilioAdapterDeps` (~3441–3520): remove the lines `moneyDashboardRepo,`, `dailyDigestRepo,`, `dunningConfigRepo,`, `droppedCallRecoveryRepo,`, `availabilityFinder,` and add `lookups: phoneLookupDeps,` next to `lookupEvents: lookupEventService,`.

In the assistant router's `lookups: { answers: lookupAnswerDeps, shared: { jobRepo, … userRepo }, … }` (~5484–5496), replace the inline `shared: { ... }` object with `shared: sharedLookupRepos,` and delete the inline comment block that described it.

- [ ] **Step 5: Build, boot-check, full api suite**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npx vitest run test/telephony test/workers test/routes/assistant-lookup-dispatch.test.ts test/app 2>&1 | tail -15
TZ=UTC npx vitest run 2>&1 | tail -15
```
Expected: 0 tsc errors; suites pass (baseline-flaky files listed at the top are the only tolerated failures, and only when run without `TZ=UTC`). If `test/app` has a `createApp` wiring-invariant characterization (PR #828), update its expectation for the removed adapter fields deliberately.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/api/src packages/api/test
git commit -m "refactor(voice): delete lookup-skill-runner; one lookup bundle for memo, chat and phone

The phone now receives the same answers+shared objects app.ts builds for the
other two surfaces (three surfaces physically cannot be wired differently).
Five adapter deps that existed only to feed the deleted switch are gone.
lookup_pending_items keeps the dropped-call recoveries line on every surface."
```

---

### Task 8: Real-Postgres proof of the five lookups on the phone path

**Files:**
- Create: `packages/api/test/integration/phone-lookups-shared-dispatch.test.ts`

Prior art to mirror exactly: `test/integration/log-expense-job-link.test.ts` (Pg repos + `createTestTenant` + `seedHendersonJob`), `test/integration/crew-voice-execution.test.ts` (tenant_settings + users + appointments seeding). Run with Docker: `colima start && cd packages/api && npm run test:integration -- test/integration/phone-lookups-shared-dispatch.test.ts`. Without Docker, it runs in PR CI — say so in your report.

- [ ] **Step 1: Write the test**

```ts
/**
 * #866 — the five lookups #843 found dead on the phone, PROVEN against real
 * Postgres at the Gather seam: real repositories, the production-shaped
 * lookup bundle, the real membership loader for RBAC, a Gather turn per
 * intent, and assertions on the spoken line against seeded rows.
 *
 * Also proves the two auth edges that matter:
 *   - an owner recognised only by tenant_settings.owner_phone (no mobile on
 *     any users row) is still answered (the owner-line bridge);
 *   - a mobile registered in tenant B never resolves an actor in tenant A.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';
import { PgLookupEventRepository } from '../../src/lookup-events/pg-lookup-event';
import { LookupEventService } from '../../src/lookup-events/lookup-event-service';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';

const TZ = 'America/Chicago';
const OWNER_PHONE = '+15125550100';
const TECH_MOBILE = '+15125550222';
const CUSTOMER_PHONE = '+15125559999';

function gatewayReturning(intentType: string, extractedEntities?: Record<string, unknown>): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96, ...(extractedEntities ? { extractedEntities } : {}) }),
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

describe('#866 — phone lookups against real Postgres (Gather seam)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let invoiceRepo: PgInvoiceRepository;
  let timeEntryRepo: PgTimeEntryRepository;
  let expenseRepo: PgExpenseRepository;
  let materialItemRepo: PgMaterialItemRepository;
  let lookups: PhoneLookupDeps;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    timeEntryRepo = new PgTimeEntryRepository(pool);
    expenseRepo = new PgExpenseRepository(pool);
    materialItemRepo = new PgMaterialItemRepository(pool);
    const membership = createAuthorizationLoader(pool);
    lookups = {
      // Production-shaped: mirrors app.ts's lookupAnswerDeps / sharedLookupRepos.
      answers: {
        invoiceRepo,
        estimateRepo: new PgEstimateRepository(pool),
        timeEntryRepo,
        expenseRepo,
        settingsRepo,
        materialItemRepo,
        lookupEvents: new LookupEventService(new PgLookupEventRepository(pool)),
        resolveMemberRole: async (tenantId, userId) => {
          const m = await membership(userId, tenantId);
          if (!m || m.deleted || m.status !== 'active') return null;
          return m.role;
        },
      },
      shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo, userRepo },
      entityResolver: new PgEntityResolver(pool),
      tenantTimezoneResolver: async () => TZ,
    };
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  interface Seed {
    tenantId: string;
    ownerUserId: string;
    techUserId: string;
    techClerkId: string;
    customerId: string;
    jobId: string;
  }

  /** Tenant with owner_phone + timezone + labor rate; an owner (NO mobile), a technician (mobile), a customer, one job assigned to the technician. */
  async function seed(): Promise<Seed> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone, labor_rate_cents_per_hour)
       VALUES ($1, $2, 'Phone Lookup Shop', $3, 'TX', $4, 8500)`,
      [crypto.randomUUID(), t.tenantId, TZ, OWNER_PHONE],
    );
    const techUserId = crypto.randomUUID();
    const techClerkId = `clerk-${techUserId}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, mobile_number)
       VALUES ($1, $2, $3, $4, 'technician', 'Jake', 'Torres', $5)`,
      [techUserId, t.tenantId, techClerkId, `jake.${techUserId.slice(0, 8)}@example.com`, TECH_MOBILE],
    );
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dana',
      lastName: 'Miller',
      displayName: 'Dana Miller',
      primaryPhone: CUSTOMER_PHONE,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '12 Oak Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-PL-${jobId.slice(0, 8)}`,
      summary: 'Miller water heater replacement',
      status: 'in_progress',
      priority: 'normal',
      assignedTechnicianId: techUserId,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenantId: t.tenantId, ownerUserId: t.userId, techUserId, techClerkId, customerId, jobId };
  }

  /** One inbound call from `from`, then one Gather turn classified as `intent`. Returns the TwiML. */
  async function callAndAsk(s: Seed, from: string, intent: string, entities?: Record<string, unknown>): Promise<string> {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gatewayReturning(intent, entities),
      businessName: 'Phone Lookup Shop',
      publicBaseUrl: 'https://example.com',
      settingsRepo,
      userRepo,
      customerRepo,
      jobRepo,
      appointmentRepo,
      proposalRepo,
      lookups,
    });
    const callSid = `CA-${intent}-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: s.tenantId });
    const session = store.findByCallSid(callSid)!;
    // Drive the FSM to intent_capture the same way the unit harnesses do
    // (greeting + identification). For the owner/tech lines there is no
    // customer to identify; mark the caller known so the lookup branch is reached.
    session.machine.dispatch({ type: 'greeted_ok' });
    if (session.machine.currentState === 'identifying') {
      session.machine.dispatch({ type: 'caller_known', customerId: s.customerId });
      session.customerId = s.customerId;
    }
    return adapter.handleGather({ sessionId: session.id, callSid, speechResult: 'lookup please', confidence: 0.95, tenantId: s.tenantId });
  }

  it('lookup_my_day: the technician calling from their registered mobile hears their own appointment', async () => {
    const s = await seed();
    const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: s.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_my_day');

    expect(xml).toContain('Miller water heater replacement');
    expect(xml).not.toContain('I&apos;m having trouble pulling that up');
  });

  it('lookup_materials: the technician hears the pending shopping list', async () => {
    const s = await seed();
    await materialItemRepo.create({ tenantId: s.tenantId, jobId: s.jobId, description: '3/4 inch copper elbows', quantity: 6, createdBy: s.ownerUserId });

    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_materials');

    expect(xml).toContain('copper elbows');
  });

  it('lookup_job_profit: the owner line (owner_phone only, no mobile on any user) names the job and hears the margin', async () => {
    const s = await seed();
    await expenseRepo.create({
      tenantId: s.tenantId,
      jobId: s.jobId,
      amountCents: 4000,
      category: 'materials',
      description: 'parts',
      createdBy: s.ownerUserId,
    } as never);

    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_job_profit', { jobReference: 'the Miller job' });

    expect(xml).not.toContain('owner-level report');
    expect(xml).not.toContain('I&apos;m having trouble pulling that up');
    expect(xml).toMatch(/margin|profit|made/i);
  });

  it('lookup_crew_schedule: the owner names Jake and hears his booking', async () => {
    const s = await seed();
    const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: s.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_crew_schedule', { targetTechnicianName: 'Jake' });

    expect(xml).toContain('Jake');
    expect(xml).not.toContain('couldn&apos;t find a crew member');
  });

  it('lookup_timesheets: the owner hears Jake\'s hours this week', async () => {
    const s = await seed();
    const clockIn = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await timeEntryRepo.create({
      id: crypto.randomUUID(),
      tenantId: s.tenantId,
      userId: s.techUserId,
      jobId: s.jobId,
      entryType: 'job',
      clockedInAt: clockIn,
      clockedOutAt: new Date(clockIn.getTime() + 2 * 60 * 60 * 1000),
      durationMinutes: 120,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_timesheets');

    expect(xml).toContain('Jake');
    expect(xml).toMatch(/2(\.0)? hours|2h/);
  });

  it('RBAC: the technician asking for revenue is refused by the REAL membership loader', async () => {
    const s = await seed();
    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_revenue');
    expect(xml).toContain('owner-level report');
  });

  it('RBAC: the customer line is refused revenue (no actor)', async () => {
    const s = await seed();
    const xml = await callAndAsk(s, CUSTOMER_PHONE, 'lookup_revenue');
    expect(xml).toContain('owner-level report');
  });

  it('suspension: a suspended technician whose mobile is still on file resolves NO actor — lookup_my_day cannot self-scope', async () => {
    const s = await seed();
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [s.techUserId]);

    const xml = await callAndAsk(s, TECH_MOBILE, 'lookup_my_day');

    expect(xml).toContain('I&apos;m having trouble pulling that up');
  });

  it('suspension: a suspended ex-owner is NOT counted against the sole-owner bridge', async () => {
    const s = await seed();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'owner', 'suspended')`,
      [crypto.randomUUID(), s.tenantId, `clerk-ex-${crypto.randomUUID()}`, `ex.${crypto.randomUUID().slice(0, 8)}@example.com`],
    );

    // lookup_pending_items: permission-gated (reports:view) and fully wired in
    // this harness (estimateRepo + invoiceRepo), so "not refused, not
    // unavailable" proves the bridge resolved the real owner.
    const xml = await callAndAsk(s, OWNER_PHONE, 'lookup_pending_items');

    expect(xml).not.toContain('owner-level report');
    expect(xml).not.toContain('I&apos;m having trouble pulling that up');
  });

  it('cross-tenant: a mobile registered in tenant B resolves NO actor in tenant A', async () => {
    const a = await seed();
    const b = await createTestTenant(pool);
    const otherMobile = '+15125550333';
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number) VALUES ($1, $2, $3, $4, 'owner', $5)`,
      [crypto.randomUUID(), b.tenantId, `clerk-b-${crypto.randomUUID()}`, `b.${crypto.randomUUID().slice(0, 8)}@example.com`, otherMobile],
    );

    const xml = await callAndAsk(a, otherMobile, 'lookup_revenue');

    expect(xml).toContain('owner-level report');
  });
});
```

Before running: open `src/materials/pg-material-item.ts`, `src/expenses/expense.ts` (`create` input shape) and `src/time-tracking/pg-time-entry.ts` (`create(entry: TimeEntry)`) and reconcile the three seed calls above with the real create signatures — they are the only calls in this file not copied from an existing integration test. Keep the assertions.

- [ ] **Step 2: Run it (Docker) or hand it to CI**

```bash
colima start 2>&1 | tail -1
cd packages/api && npm run test:integration -- test/integration/phone-lookups-shared-dispatch.test.ts 2>&1 | tail -25
```
Expected: 10 passing. If a spoken-line assertion misses because the skill's real copy differs (e.g. "Jake logged 2 hours this week"), print the XML once, pin the actual phrase, and keep the row-derived content (the name, the job summary, the material) as the thing asserted.

If Docker is unavailable: commit, push, and read the `test` workflow's integration job on the PR; fix from its output.

- [ ] **Step 3: Commit**

```bash
git add packages/api/test/integration/phone-lookups-shared-dispatch.test.ts
git commit -m "test(integration): prove the five phone lookups, the owner-line bridge and cross-tenant actor isolation against real Postgres"
```

---

### Task 9: Documentation follows the structure

**Files:**
- Modify: `docs/reference/voice-action-catalog.md` (section E, lines ~1294–1322)
- Modify: `packages/api/src/ai/orchestration/lookup-dispatch.ts` (header paragraph 2, "The authorization model")
- Create: `CONTEXT.md`
- Modify: `docs/decisions.md` (append D-026)
- Create: `docs/solutions/logic-errors/phone-lookup-dispatch-had-no-authorization-behind-the-prompt.md`

- [ ] **Step 1: Catalog section E**

Replace the blockquote that begins `> **⚠️ A new lookup intent is NOT covered automatically.**` (through `> \`CUSTOMER_SCOPED_LOOKUP_INTENTS\` (\`workers/voice-lookup-answer.ts\`).`) with:

```markdown
> **Dispatch is ONE switch behind THREE surface adapters (#866).** Classification
> is a prefix test (`isLookupIntent`, `intent-classifier.ts`), and dispatch is the
> single enumerated switch in `workers/voice-lookup-answer.ts#executeLookupAnswer`,
> reached by:
>
> | Surface | Surface adapter (owns identity, response shape, failure copy, telemetry — never a switch) |
> |---|---|
> | recorded memo | `workers/voice-action-router.ts` |
> | in-app chat (mic + typed) | `ai/orchestration/lookup-dispatch.ts` |
> | live phone (Gather today; media-streams when #860 step 2 lands) | `ai/voice-turn/phone-lookup-surface.ts` |
>
> A new `lookup_*` skill is added to the shared switch **once** and answers on
> every surface. Two supporting registries remain per-intent and are NOT
> prefix-driven: `LOOKUP_REQUIRED_PERMISSION` (who may hear it — the phone now
> enforces this on the caller's resolved actor, not on caller-ID alone) and
> `CUSTOMER_SCOPED_LOOKUP_INTENTS` (which lookups need a customer). A missing
> entry in the switch degrades to `unsupported`; on the phone that speaks the
> unavailable line AND logs a wiring-gap warning AND emits `lookup_executed`
> with `error: 'unsupported'` — a metric, not a silent degradation.
>
> History: until 2026-08 the live phone carried its own 14-case copy of this
> switch (`telephony/twilio-adapter.ts`, then `lookup-skill-runner.ts`), and five
> lookups were unreachable on the phone (#843). The duplication was the defect.
```

Also in the paragraph above it, `— 20 \`lookup_*\` intents total — routed to read-only skills, never to a proposal (correct by design).` stays as-is.

- [ ] **Step 2: `lookup-dispatch.ts` header**

In the header block's item `2. The authorization model.`, replace the sentence `The phone path gates owner lookups on \`ownerSession\` (caller-ID identity) AND \`extendedIntents\` (…keeping an anonymous caller away from owner reports).` through `Neither applies to a signed-in operator on their own dashboard.` with:

```
 *   2. The authorization model. Every surface now uses the DB-authoritative
 *      RBAC gate the shared module enforces (`LOOKUP_REQUIRED_PERMISSION`).
 *      Chat passes the signed-in operator (`req.auth.userId`); the phone
 *      passes the actor it resolved from caller-ID at session establishment
 *      (`telephony/phone-actor.ts`, #866); the memo passes its creator.
```
Keep the rest of item 2 (the permission list and "fails CLOSED").

- [ ] **Step 3: `CONTEXT.md`**

```markdown
# ServiceOS domain glossary

Terms this codebase uses with a specific meaning. Decisions live in
`docs/decisions.md`; the speakable capability inventory in
`docs/reference/voice-action-catalog.md`. Coined during the voice-first
effort (#833); add to it rather than letting terms float.

- **Surface** — a way a person reaches the product: the live phone, a recorded
  memo, in-app chat (mic or typed). Web and mobile UI are surfaces too, but
  "surface" in voice docs means one of the three voice surfaces.
- **Transport** — an implementation of the phone surface: Twilio Gather,
  Twilio Media Streams (ConversationRelay is a third, not yet used). A
  capability targets "the phone", never a transport.
- **Shared dispatch** — the one per-skill implementation a family of
  capabilities runs through, regardless of surface. For lookups:
  `workers/voice-lookup-answer.ts#executeLookupAnswer`.
- **Surface adapter** — the thin per-surface caller of a shared dispatch. It
  owns only what is genuinely surface-specific: identity, reference
  resolution, response shape, failure copy, telemetry. It never contains a
  switch. Adding a surface means adding an adapter, not copying the switch.
- **Actor** — the tenant user a request is authorised AS. Chat: the signed-in
  operator. Memo: the recording's creator. Phone: resolved once from caller-ID
  at session establishment (`telephony/phone-actor.ts`) and stored as
  `session.actorUserId`; never derived from anything the caller says.
- **Owner line** — a caller-ID that matches `tenant_settings.owner_phone` or
  the backup supervisor's mobile (`ownerSession`). Transport-level
  recognition, not identity proof; it gates voice approval (RV-071) and is one
  input to actor resolution, but it does not authorise lookups by itself.
- **Capability** — one thing a tradesperson can do by speaking: an intent plus
  whatever answers or executes it. The catalog lists them; the map (#833) is
  about making their surface coverage structural.
- **Parity** — the same capability behaves the same on every surface it
  targets. Structural parity means a new capability cannot land on one surface
  and silently miss another.
- **Proven** — a capability has a real-database integration test on the
  surface in question (`test/integration/`), not only an in-memory one.
- **Proposal-first** (D-004) — the AI never writes to operational entities;
  it drafts a typed proposal a human approves. Lookups are read-only and are
  never proposals.
```

- [ ] **Step 4: D-026 in `docs/decisions.md`** (append after D-025, same format)

```markdown
### D-026: The phone authorises lookups by a caller-ID-resolved actor's DB role, through the shared dispatch
**Date:** 2026-08-26
**Initiative:** Voice-first on the phone (wayfinder map #833), Phase 0 of #852; spec #866, closes #843.
**Decision:** The live phone is the third caller of the shared lookup dispatch
(`workers/voice-lookup-answer.ts`); its private switch is deleted. Authorization on the phone is
the shared module's DB-authoritative RBAC gate applied to an **actor** resolved **once at
session establishment** from caller-ID (`telephony/phone-actor.ts`: registered mobile → user;
else owner line → the tenant's single active owner; else none), never from utterance content.
The `ownerSession && extendedIntents` dispatch-side gate is removed; the tenant flag continues to
gate only whether the classifier *offers* the owner-extended intents. One phone-specific rule
remains at dispatch: an owner-extended intent (`OWNER_EXTENDED_LOOKUP_INTENT_TYPES`) with **no
resolved actor** is refused with the shared module's refusal copy — the phone is the only surface
with anonymous/customer callers, and `lookup_day_overview` carries no permission entry on purpose
(any signed-in operator may hear it on memo/chat).
**Rationale:** Five lookups were unreachable on the phone because the phone carried its own
14-case copy of a 20-case switch (#843). The shared module's gate and `lookup_my_day`'s
self-scoping both require an actor, so the "minimal fix" was not available through the shared
path. Verified while specifying: `lookup_revenue` and `lookup_leads` sit in the base classifier
prompt and the phone's dispatch applied no authorization after customer identification — an
identified customer could be read the tenant's revenue. RBAC at dispatch is the missing
defence-in-depth layer behind the prompt.
**Constraints:** Caller-ID is the *authentication factor* that mints the phone actor. It is
transport-level recognition, spoofable by design, and no stronger than the RV-070 owner-line
check that already gated owner lookups and voice approval — `actorUserId` must never be read
as a verified subject the way `req.auth.userId` is. No classifier prompt / taxonomy /
cassette change. `ownerSession` keeps its RV-071 approval role unchanged (D-025). Customer-name resolution on the phone stays
undecided (#833 "entity resolution per surface"). #860 step 2 (media-streams) calls the same
surface adapter; it is not wired here.
```

- [ ] **Step 5: Solutions entry**

```markdown
---
title: "Phone lookup dispatch had no authorization behind the classifier prompt — an identified customer could hear tenant revenue"
date: 2026-08-26
track: bug
problem_type: logic-errors
module: "packages/api/src/telephony/twilio-adapter.ts, packages/api/src/ai/voice-turn/phone-lookup-surface.ts, packages/api/src/telephony/phone-actor.ts"
tags: ["voice", "telephony", "lookups", "rbac", "defence-in-depth", "prompt-gating", "surface-adapter", "parity"]
related: ["docs/solutions/workflow-issues/adding-a-voice-intent-requires-four-coordinated-updates.md"]
---

## Problem
The live phone carried its own copy of the lookup switch (14 of 20 cases) instead of calling
the shared dispatch the memo and chat surfaces use. Two consequences:

1. Five lookups (`lookup_my_day`, `lookup_materials`, `lookup_job_profit`, `lookup_crew_schedule`,
   `lookup_timesheets`) fell to `default` and answered "let me get a person" — with no metric (#843).
2. The copy's only authorization was the caller-ID boolean, applied to a subset of intents.
   `lookup_revenue` and `lookup_leads` live in the base classifier `SYSTEM_PROMPT` (offered to
   every caller) and the phone's switch had **no** check on them after customer identification.
   The only thing between an identified customer and the tenant's revenue figure was prompt wording.

## Root cause
Prompt gating was treated as authorization. The shared module authorises by the asking
**actor's** DB role and fails closed; the phone had no actor, only `ownerSession`.

## Fix
- Phone becomes the third caller of `executeLookupAnswer` via a thin surface adapter
  (`ai/voice-turn/phone-lookup-surface.ts`); the private switch is deleted.
- Caller-ID resolves to an actor once at session establishment (`telephony/phone-actor.ts`) and is
  stored as `session.actorUserId`. Order: registered mobile → user; owner line → sole active owner
  (bridge, so owners without a mobile on their profile don't regress); else none.
- The shared RBAC gate then applies on the phone. Identified customers are refused owner reports.

## How to recognise it next time
- A surface with its own copy of a shared switch. `grep -rn "case 'lookup_"` should hit ONE
  production file.
- "Gated by the prompt" anywhere in a comment. The prompt decides what the model may *say*;
  it must never be the only thing deciding what the system *does*.
- A boolean where the shared module wants an identity.

## Tests that pin it
`test/telephony/lookup-dispatch-characterization.test.ts` (Gather seam, all outcomes),
`test/telephony/phone-actor.test.ts`, `test/integration/phone-lookups-shared-dispatch.test.ts`
(real Postgres + real membership loader).
```

- [ ] **Step 6: Commit**

```bash
git add docs/reference/voice-action-catalog.md packages/api/src/ai/orchestration/lookup-dispatch.ts CONTEXT.md docs/decisions.md docs/solutions/logic-errors/phone-lookup-dispatch-had-no-authorization-behind-the-prompt.md
git commit -m "docs(voice): catalog section E = one dispatch, three surface adapters; CONTEXT.md glossary; D-026; solutions entry"
```

---

### Task 10: Final verification and PR

- [ ] **Step 1: Full verification**

```bash
cd packages/api
npx tsc --project tsconfig.build.json --noEmit          # must be 0
TZ=UTC npx vitest run 2>&1 | tail -8                       # full api suite
grep -rn "runLookupSkill\|lookup-skill-runner" src test | grep -v text-mode-driver   # must be empty
grep -c "case 'lookup_" src/workers/voice-lookup-answer.ts src/ai/voice-quality/text-mode-driver.ts   # shared=20; harness copy unchanged (out of scope)
```

- [ ] **Step 2: Push and open the PR**

Pushing auto-creates a PR on this repo (title truncated, body = raw commit message). Fix it with `gh pr edit`:

```bash
git push -u origin feat/phone-lookups-shared-dispatch
sleep 20
N=$(gh pr list --head feat/phone-lookups-shared-dispatch --json number --jq '.[0].number')
gh pr edit "$N" --title "feat(voice): phone lookups through the shared dispatch, authorised by caller identity (closes #843)" --body-file docs/superpowers/plans/pr-866-body.md
```

Write `docs/superpowers/plans/pr-866-body.md` (do not commit it) with: the spec link (#866), the five lookups now answering, the defence-in-depth finding, the auth decision (D-026) and the owner-line bridge, the list of observable changes (dispatchers/technicians gain role-appropriate lookups; identified customers lose owner reports; `voice.lookup-skill-runner` log service name gone; `lookup_pending_items` recoveries line now on memo/chat too), the red→green evidence per task (paste the failing output tails), and the verification tails from Step 1. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Watch CI** — the `test` workflow runs the integration job. If `phone-lookups-shared-dispatch.test.ts` is red, fix seeds/assertions from its output (Task 8 note), push, re-check. Confirm the merge state with `gh pr view $N --json mergeable,statusCheckRollup`.

---

## Self-review against spec #866

- Decisions 1 (one dispatch, adapter deleted, transport-neutral interface, FSM contract) → Tasks 3, 7. ✔
- Decision 2 (one bundle built once; three of five needed missing repos) → Task 7 (`sharedLookupRepos`, `phoneLookupDeps`, `lookupAnswerDeps` already carries time-entry/expense/material repos). ✔
- Decision 3 (actor once at establishment, order, fail-soft, warning) → Tasks 1, 2. ✔
- Decision 4 (RBAC at dispatch; flag gates classification only) → Tasks 3, 4 (explicit "flag-off owner actor answered" test). ✔
- Decision 5 (caller = customer; unidentified copy; no customer-name resolution) → Task 3 adapter + "unidentified caller" pin. ✔
- Decision 6 (job/crew/day references via shared resolver; spoken ambiguity) → Tasks 3, 5. ✔
- Decision 7 (response mapping incl. unsupported warning) → Tasks 3, 6. ✔
- Decision 8 (telemetry every outcome) → Task 6. ✔
- Decision 9 (pins flipped) → Tasks 3, 4. ✔
- Decision 10 (catalog, headers, glossary) → Task 9; D-026 added. ✔
- Decision 11 (observable changes in PR) → Task 10. ✔
- Testing seam 2 (real Postgres incl. owner-phone-only owner + cross-tenant) → Task 8. ✔
- Out of scope respected: no media-streams wiring, no prompt change, text-mode-driver untouched.
- Type consistency: `PhoneLookupDeps` / `answerPhoneLookup` / `LOOKUP_UNAVAILABLE_LINE` / `resolvePhoneActor` / `PhoneActorDeps` / `resolveLookupReference` / `ambiguousReferenceLine` / `actorUserId` used with the same names in every task.
