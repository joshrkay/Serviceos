/**
 * Wire-contract pin: the draft the API builds must parse, field for field,
 * with the schemas in @ai-service-os/shared that the web client uses. The
 * API's own schemas stay where they are; this test fails when either side
 * adds, renames or drops a field, so api and web cannot drift silently.
 */
import { describe, it, expect } from 'vitest';
import {
  ApproveOnboardingDraftBodySchema,
  ApproveOnboardingDraftResponseSchema,
  CreateOnboardingDraftBodySchema,
  CreateOnboardingDraftResponseSchema,
  ONBOARDING_CHOICE_KEYS,
  ONBOARDING_CORE_CHOICE_KEYS,
  ONBOARDING_DRAFT_EXECUTION_STATES,
  ONBOARDING_DRAFT_RECOVERY,
  ONBOARDING_DRAFT_REFUSALS,
  ONBOARDING_METROS,
  ONBOARDING_REGISTRY_TRADES,
  OnboardingDraftResponseSchema,
  OnboardingDraftSchema,
  OnboardingStatusDraftSchema,
  RetryOnboardingDraftBodySchema,
  RetryOnboardingDraftResponseSchema,
  SetOnboardingMetroBodySchema,
  StageOnboardingChoiceBodySchema,
  UndoOnboardingDraftBodySchema,
  UndoOnboardingDraftResponseSchema,
} from '@ai-service-os/shared';
import { DRAFT_EXECUTION_STATES, DRAFT_RECOVERY_HINTS, OnboardingStatusResponseSchema } from '../../../src/onboarding/contracts';
import { deriveOnboardingStatus, type DraftProposalMember, type OnboardingFacts } from '../../../src/onboarding/derive-status';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { ALL_CHOICE_KEYS, CHOICE_KEYS } from '../../../src/onboarding/choices/schema';
import { REGISTRY_TRADES } from '../../../src/onboarding/choices/registry';
import { NPA_METROS, metroForPhone } from '../../../src/compliance/us-geography';
import { InMemoryOnboardingDraftRepository } from '../../../src/onboarding/draft/repository';
import {
  ApproveDraftBodySchema,
  CreateDraftInputSchema,
  DRAFT_REFUSAL_CODES,
  RetryDraftBodySchema,
  SetMetroBodySchema,
  StageChoiceBodySchema,
  UndoDraftBodySchema,
} from '../../../src/onboarding/draft/contracts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { approveDraft } from '../../../src/onboarding/draft/approve';
import { undoApprovedDraft } from '../../../src/onboarding/draft/undo';
import { retryFailedDraftProposals } from '../../../src/onboarding/draft/retry';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT_ID = '00000000-0000-0000-0000-0000000000a1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

/** What Express does to a response body: Dates become ISO strings, undefined keys vanish. */
const overTheWire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

async function buildDraft(packId: string, phone: string | null) {
  const tierRepo = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE });
  const assembled = await assembleTypicalShop(tierRepo, {
    packId,
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    metro: phone ? metroForPhone(phone) : null,
  });
  const repo = new InMemoryOnboardingDraftRepository();
  const draft = await repo.create(TENANT_ID, {
    packId,
    trade: assembled.trade,
    metroCode: assembled.metroCode,
    metroName: assembled.metroName,
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    clientTimezone: 'America/New_York',
    assembled,
  });
  return { repo, draft };
}

describe('onboarding draft wire contract (api <-> shared)', () => {
  it('parses a freshly created metro draft and loses no field', async () => {
    const { draft } = await buildDraft('plumbing', '(216) 555-0142');
    const wire = overTheWire(draft);
    const parsed = OnboardingDraftSchema.parse(wire);
    expect(parsed).toEqual(wire);
    expect(parsed.assembled.showsCity).toBe(true);
    expect(parsed.assembled.choices).toHaveLength(ALL_CHOICE_KEYS.length);
  });

  it('parses draft variants: pack-default prices, generic trade, staged option and override, approved', async () => {
    const generic = await buildDraft('painting', null);
    expect(OnboardingDraftSchema.parse(overTheWire(generic.draft))).toEqual(overTheWire(generic.draft));

    const { repo, draft } = await buildDraft('plumbing', '(216) 555-0142');
    const s1 = await repo.stageChoice(TENANT_ID, 'booking_posture', { option: 'b' }, draft.version);
    const s2 = await repo.stageChoice(
      TENANT_ID,
      'trip_fee_and_rate',
      { override: { label: '$95, then $140 an hour', writes: {}, prices: { tripFeeCents: 9500, hourlyRateCents: 14000 } } },
      s1.version,
    );
    const s3 = await repo.stageChoice(
      TENANT_ID,
      'greeting',
      { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } },
      s2.version,
    );
    expect(OnboardingDraftSchema.parse(overTheWire(s3))).toEqual(overTheWire(s3));

    const approved = await repo.markApproved(TENANT_ID, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], s3.version);
    const wire = overTheWire(approved);
    expect(OnboardingDraftSchema.parse(wire)).toEqual(wire);
  });

  it('parses every response envelope the draft routes send', async () => {
    const { draft } = await buildDraft('plumbing', '(216) 555-0142');
    const wireDraft = overTheWire(draft);
    expect(CreateOnboardingDraftResponseSchema.parse({ draft: wireDraft, created: true }).created).toBe(true);
    expect(OnboardingDraftResponseSchema.parse({ draft: wireDraft }).draft.version).toBe(1);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    expect(ApproveOnboardingDraftResponseSchema.parse({ draft: wireDraft, proposalIds: ids, approvedNow: true }).proposalIds).toEqual(ids);
  });

  it('accepts exactly the request bodies the API accepts', () => {
    const create = { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', phone: '(216) 555-0142', clientTimezone: 'America/New_York' };
    expect(CreateDraftInputSchema.safeParse(create).success).toBe(true);
    expect(CreateOnboardingDraftBodySchema.safeParse(create).success).toBe(true);
    for (const bad of [{ packId: '' }, { ...create, extra: 1 }, { ...create, businessName: 'x'.repeat(121) }]) {
      expect(CreateOnboardingDraftBodySchema.safeParse(bad).success).toBe(CreateDraftInputSchema.safeParse(bad).success);
    }

    const stage = [
      { choice: { option: 'a' }, version: 1 },
      { choice: { option: 'c' }, version: 1 },
      { choice: { option: 'a' }, version: 0 },
      { choice: { override: { label: 'x', writes: { voiceGreeting: 'hi' } } }, version: 3 },
      { choice: { override: { label: '', writes: {} } }, version: 3 },
      { choice: { option: 'a' }, version: 1, extra: true },
    ];
    for (const body of stage) {
      expect(StageOnboardingChoiceBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(StageChoiceBodySchema.safeParse(body).success);
    }
  });

  it('parses a real draft whether or not the API sends ownerPhone, and still rejects an unknown field', async () => {
    const { draft } = await buildDraft('plumbing', '(216) 555-0142');
    const wire = overTheWire(draft) as Record<string, unknown>;
    // An API that predates the field omits it; one that has it sends E.164 or null. Both must parse.
    const { ownerPhone: _omitted, ...without } = wire;
    expect(OnboardingDraftSchema.parse(without)).toEqual(without);
    for (const ownerPhone of [null, '+12165550142']) {
      expect(OnboardingDraftSchema.parse({ ...wire, ownerPhone }).ownerPhone).toBe(ownerPhone);
    }
    expect(OnboardingDraftSchema.safeParse({ ...wire, surprise: true }).success).toBe(false);
  });

  it('parses the retry response with a real approved draft', async () => {
    const { repo, draft } = await buildDraft('plumbing', '(216) 555-0142');
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const approved = overTheWire(await repo.markApproved(TENANT_ID, ids, draft.version));
    const parsed = RetryOnboardingDraftResponseSchema.parse({ draft: approved, retriedProposalIds: [ids[1]] });
    expect(parsed.retriedProposalIds).toEqual([ids[1]]);
    expect(RetryOnboardingDraftResponseSchema.safeParse({ draft: overTheWire(draft) }).success).toBe(false);
  });

  it('accepts only an approve body the API accepts (optional expectedVersion, strict)', () => {
    const cases: Array<[unknown, boolean]> = [
      [{}, true],
      [{ expectedVersion: 1 }, true],
      [{ expectedVersion: 0 }, false],
      [{ expectedVersion: 1.5 }, false],
      [{ expectedVersion: 1, extra: 1 }, false],
    ];
    for (const [body, ok] of cases) {
      expect(ApproveOnboardingDraftBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(ok);
      expect(ApproveDraftBodySchema.safeParse(body).success, `api ${JSON.stringify(body)}`).toBe(ok);
    }
  });

  it('keeps the metro list the web offers equal to the API table, code and name, in order', () => {
    expect(ONBOARDING_METROS.map((m) => ({ code: m.code, name: m.name }))).toEqual(
      Object.entries(NPA_METROS).map(([code, entry]) => ({ code, name: entry.name })),
    );
  });

  it('accepts exactly the metro bodies the API accepts', () => {
    const cases: unknown[] = [
      { metro: 'CMH', version: 1 },
      { metro: 'CLE', version: 9 },
      ...Object.keys(NPA_METROS).map((metro) => ({ metro, version: 2 })),
      { metro: 'cmh', version: 1 },
      { metro: 'Columbus', version: 1 },
      { metro: 'ZZZ', version: 1 },
      { metro: 'US', version: 1 },
      { metro: 'CMH' },
      { metro: 'CMH', version: 0 },
      { metro: 'CMH', version: 1.5 },
      { version: 1 },
      { metro: 'CMH', version: 1, name: 'Columbus' },
    ];
    for (const body of cases) {
      expect(SetOnboardingMetroBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(SetMetroBodySchema.safeParse(body).success);
    }
    expect(SetMetroBodySchema.safeParse({ metro: 'CMH', version: 1 }).success).toBe(true);
    expect(SetMetroBodySchema.safeParse({ metro: 'Columbus', version: 1 }).success).toBe(false);
  });

  it('parses a metro-changed draft and loses no field', async () => {
    const { repo, draft } = await buildDraft('plumbing', '(216) 555-0142');
    const tierRepo = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE });
    for (const [code, name] of [['CMH', 'Columbus'], ['BUF', 'Buffalo']] as const) {
      const current = (await repo.getForTenant(TENANT_ID))!;
      const changed = await repo.setMetro(TENANT_ID, code, current.version, (row) =>
        assembleTypicalShop(tierRepo, { packId: row.packId, businessName: row.businessName, metro: { kind: 'metro', metroCode: code, name } }),
      );
      const wire = overTheWire(changed);
      expect(OnboardingDraftResponseSchema.parse({ draft: wire }).draft).toEqual(wire);
    }
    expect((await repo.getForTenant(TENANT_ID))!.version).toBe(draft.version + 2);
  });

  it('keeps the execution states equal to the API list', () => {
    expect([...ONBOARDING_DRAFT_EXECUTION_STATES]).toEqual(['pending', 'executing', 'executed', 'failed', 'stopped']);
    expect([...ONBOARDING_DRAFT_EXECUTION_STATES]).toEqual([...DRAFT_EXECUTION_STATES]);
  });

  it('keeps the recovery hints equal to the API list', () => {
    expect([...ONBOARDING_DRAFT_RECOVERY]).toEqual(['reset', 'settings']);
    expect([...ONBOARDING_DRAFT_RECOVERY]).toEqual([...DRAFT_RECOVERY_HINTS]);
  });

  it('parses the status draft block the API derives, with and without undoable and recovery, on both sides', () => {
    const T0 = new Date('2026-10-19T12:00:00.000Z');
    const facts = (draft: OnboardingFacts['draft']): OnboardingFacts => ({
      tenantId: TENANT_ID,
      tenantExists: true,
      identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null, timezone: null },
      packActivated: false,
      twilioStatus: null,
      subscription: { stripeSubscriptionId: null, status: null },
      inboundCallCount: 0,
      testCallSkippedAt: null,
      voiceAgentLiveAt: null,
      activatedAt: null,
      aiConfigPresent: false,
      aiVerificationStatus: null,
      aiVerificationSkippedAt: null,
      draft,
    });
    const approved = (members: DraftProposalMember[]) =>
      facts({ status: 'approved', choicesAnswered: 7, version: 3, proposals: { expected: 2, members } });
    const now = new Date(T0.getTime() + 1000);
    const blocks = [
      // Editing: neither hint.
      facts({ status: 'draft', choicesAnswered: 3, version: 4 }),
      // Fresh approval: undoable, no recovery.
      approved([{ status: 'approved', approvedAt: T0 }, { status: 'approved', approvedAt: T0 }]),
      // A stopped set: both hints.
      approved([{ status: 'undone', approvedAt: T0 }, { status: 'approved', approvedAt: T0 }]),
    ].map((f) => overTheWire(deriveOnboardingStatus(f, now).draft));

    expect(blocks[0]).not.toHaveProperty('undoable');
    expect(blocks[1]).toMatchObject({ undoable: true });
    expect(blocks[2]).toMatchObject({ undoable: false, recovery: 'reset' });
    for (const block of blocks) {
      expect(OnboardingStatusDraftSchema.parse(block)).toEqual(block);
    }

    // An API that predates the hints (S1b) still parses on both sides.
    const s1b = { status: 'approved', choicesAnswered: 7, version: 2, execution: 'pending' };
    expect(OnboardingStatusDraftSchema.parse(s1b)).toEqual(s1b);
    const status = overTheWire(deriveOnboardingStatus(approved([]), now)) as Record<string, unknown>;
    expect(OnboardingStatusResponseSchema.parse({ ...status, draft: s1b }).draft).toEqual(s1b);
    expect(OnboardingStatusResponseSchema.parse(status).draft).toEqual(status.draft);

    // Both sides refuse the same unknown values.
    for (const bad of [{ ...s1b, recovery: 'inbox' }, { ...s1b, undoable: 'yes' }]) {
      expect(OnboardingStatusDraftSchema.safeParse(bad).success).toBe(false);
      expect(OnboardingStatusResponseSchema.safeParse({ ...status, draft: bad }).success).toBe(false);
    }
  });

  it('S4: accepts exactly the undo and retry bodies the API accepts (undo requires the version, retry may omit it; both strict)', () => {
    const cases: Array<[unknown, boolean, boolean]> = [
      // body, undo ok, retry ok
      [{}, false, true],
      [{ expectedVersion: 3 }, true, true],
      [{ expectedVersion: 0 }, false, false],
      [{ expectedVersion: -1 }, false, false],
      [{ expectedVersion: 1.5 }, false, false],
      [{ expectedVersion: '3' }, false, false],
      [{ expectedVersion: 3, extra: 1 }, false, false],
    ];
    for (const [body, undoOk, retryOk] of cases) {
      const label = JSON.stringify(body);
      expect(UndoOnboardingDraftBodySchema.safeParse(body).success, `shared undo ${label}`).toBe(undoOk);
      expect(UndoDraftBodySchema.safeParse(body).success, `api undo ${label}`).toBe(undoOk);
      expect(RetryOnboardingDraftBodySchema.safeParse(body).success, `shared retry ${label}`).toBe(retryOk);
      expect(RetryDraftBodySchema.safeParse(body).success, `api retry ${label}`).toBe(retryOk);
    }
  });

  it('S4: parses the real undo response and the real retry response, with and without undoable', async () => {
    const { repo: draftRepo } = await buildDraft('plumbing', '(216) 555-0142');
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const owner = { userId: 'user-owner-1', role: 'owner' as const };
    const deps = { draftRepo, proposalRepo, auditRepo };

    const first = await approveDraft(deps, TENANT_ID, owner);
    const undone = await undoApprovedDraft(deps, TENANT_ID, owner, { expectedVersion: first.draft.version });
    // The route answers { draft } only.
    const undoWire = overTheWire({ draft: undone.draft });
    expect(UndoOnboardingDraftResponseSchema.parse(undoWire)).toEqual(undoWire);
    expect(UndoOnboardingDraftResponseSchema.safeParse({ ...(undoWire as object), undoneProposalIds: [] }).success).toBe(false);

    const second = await approveDraft(deps, TENANT_ID, owner);
    for (const id of second.proposalIds) await proposalRepo.update(TENANT_ID, id, { status: 'execution_failed' });
    const retried = overTheWire(await retryFailedDraftProposals(deps, TENANT_ID, owner)) as Record<string, unknown>;
    expect(retried).toHaveProperty('undoable', true);
    expect(RetryOnboardingDraftResponseSchema.parse(retried)).toEqual(retried);
    // An API that predates the field (S1b) still parses; a wrong type does not.
    const { undoable: _u, ...s1b } = retried;
    expect(RetryOnboardingDraftResponseSchema.parse(s1b)).toEqual(s1b);
    expect(RetryOnboardingDraftResponseSchema.safeParse({ ...retried, undoable: 'yes' }).success).toBe(false);
  });

  it('S4: keeps the refusal codes equal on both sides, and every CODE: the draft sources throw is in the list', () => {
    expect([...ONBOARDING_DRAFT_REFUSALS]).toEqual([...DRAFT_REFUSAL_CODES]);
    for (const code of ['DRAFT_UNDO_REFUSED', 'UNDO_WINDOW_CLOSED', 'DRAFT_NOT_APPROVED', 'VERSION_CONFLICT']) {
      expect(ONBOARDING_DRAFT_REFUSALS).toContain(code);
    }
    const src = join(__dirname, '../../../src');
    const draftDir = join(src, 'onboarding/draft');
    const files = [join(src, 'routes/onboarding-draft.ts'), ...readdirSync(draftDir).filter((f) => f.endsWith('.ts')).map((f) => join(draftDir, f))];
    const thrown = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/ConflictError\(\s*[`'"]([A-Z_]+):/g)) thrown.add(m[1]);
    }
    expect(thrown.size).toBeGreaterThan(5);
    expect([...thrown].filter((c) => !(DRAFT_REFUSAL_CODES as readonly string[]).includes(c))).toEqual([]);
  });

  it('keeps the shared choice-key and trade lists equal to the API registry', () => {
    expect([...ONBOARDING_CHOICE_KEYS]).toEqual([...ALL_CHOICE_KEYS]);
    expect([...ONBOARDING_CORE_CHOICE_KEYS]).toEqual([...CHOICE_KEYS]);
    expect([...ONBOARDING_REGISTRY_TRADES]).toEqual([...REGISTRY_TRADES]);
  });
});
