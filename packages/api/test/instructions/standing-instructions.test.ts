import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  InMemoryStandingInstructionRepository,
  MAX_ACTIVE_STANDING_INSTRUCTIONS,
  MAX_APPLICABLE_STANDING_INSTRUCTIONS,
  StandingInstruction,
  StandingInstructionLimitError,
  createStandingInstruction,
  deactivateStandingInstruction,
  selectApplicableInstructions,
  standingInstructionScopeSchema,
} from '../../src/instructions/standing-instructions';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { NotFoundError, ValidationError } from '../../src/shared/errors';

const TENANT = 'tenant-1';

function makeInstruction(overrides: Partial<StandingInstruction> = {}): StandingInstruction {
  const now = new Date('2026-07-01T12:00:00Z');
  return {
    id: randomUUID(),
    tenantId: TENANT,
    instruction: 'Always add a fuel surcharge',
    scope: {},
    active: true,
    source: 'settings',
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    deactivatedAt: null,
    deactivatedBy: null,
    ...overrides,
  };
}

describe('standingInstructionScopeSchema', () => {
  it('accepts an empty scope', () => {
    expect(standingInstructionScopeSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully-populated valid scope', () => {
    const result = standingInstructionScopeSchema.safeParse({
      intents: ['create_estimate'],
      tradeCategories: ['hvac'],
      customerSegment: 'new',
      amountCents: 5000,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['negative amountCents', { amountCents: -100 }],
    ['float amountCents', { amountCents: 50.5 }],
    ['unknown customerSegment', { customerSegment: 'vip' }],
    ['unknown keys', { discountPercent: 10 }],
    ['empty-string intent', { intents: [''] }],
  ])('rejects %s', (_label, scope) => {
    expect(standingInstructionScopeSchema.safeParse(scope).success).toBe(false);
  });
});

describe('selectApplicableInstructions', () => {
  const ctx = { intentType: 'create_estimate' };

  it('returns empty for an empty list', () => {
    expect(selectApplicableInstructions([], ctx)).toEqual([]);
  });

  it('excludes inactive instructions even if passed in', () => {
    const inactive = makeInstruction({ active: false });
    expect(selectApplicableInstructions([inactive], ctx)).toEqual([]);
  });

  it('excludes intent-scoped instructions whose intents do not match', () => {
    const other = makeInstruction({ scope: { intents: ['create_invoice'] } });
    expect(selectApplicableInstructions([other], ctx)).toEqual([]);
  });

  it('orders exact-intent > tradeCategory-scoped > unscoped', () => {
    const unscoped = makeInstruction({ createdAt: new Date('2026-06-30T00:00:00Z') });
    const trade = makeInstruction({
      scope: { tradeCategories: ['hvac'] },
      createdAt: new Date('2026-06-29T00:00:00Z'),
    });
    const intent = makeInstruction({
      scope: { intents: ['create_estimate'] },
      createdAt: new Date('2026-06-28T00:00:00Z'),
    });
    // Deliberately pass in reverse-priority order.
    const selected = selectApplicableInstructions([unscoped, trade, intent], ctx);
    expect(selected.map((i) => i.id)).toEqual([intent.id, trade.id, unscoped.id]);
  });

  it('orders newest-first within a priority band', () => {
    const older = makeInstruction({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = makeInstruction({ createdAt: new Date('2026-06-15T00:00:00Z') });
    const selected = selectApplicableInstructions([older, newer], ctx);
    expect(selected.map((i) => i.id)).toEqual([newer.id, older.id]);
  });

  it('caps output at 5, dropping the lowest-priority instructions first', () => {
    const intents = [1, 2].map((d) =>
      makeInstruction({
        scope: { intents: ['create_estimate'] },
        createdAt: new Date(`2026-06-0${d}T00:00:00Z`),
      })
    );
    const trades = [3, 4].map((d) =>
      makeInstruction({
        scope: { tradeCategories: ['hvac'] },
        createdAt: new Date(`2026-06-0${d}T00:00:00Z`),
      })
    );
    const unscoped = [5, 6, 7].map((d) =>
      makeInstruction({ createdAt: new Date(`2026-06-0${d}T00:00:00Z`) })
    );
    const selected = selectApplicableInstructions([...unscoped, ...trades, ...intents], ctx);

    expect(selected).toHaveLength(MAX_APPLICABLE_STANDING_INSTRUCTIONS);
    // Both intent-scoped, both trade-scoped, then only the newest unscoped.
    expect(selected.slice(0, 2).map((i) => i.id).sort()).toEqual(
      intents.map((i) => i.id).sort()
    );
    expect(selected.slice(2, 4).map((i) => i.id).sort()).toEqual(trades.map((i) => i.id).sort());
    expect(selected[4].id).toBe(unscoped[2].id); // 2026-06-07, newest unscoped
  });

  it('is deterministic when createdAt ties (id tie-break)', () => {
    const a = makeInstruction();
    const b = makeInstruction();
    const forward = selectApplicableInstructions([a, b], ctx);
    const reversed = selectApplicableInstructions([b, a], ctx);
    expect(forward.map((i) => i.id)).toEqual(reversed.map((i) => i.id));
  });

  it.each([
    // [scope segment, context segment, included?]
    ['new', 'new', true],
    ['new', 'existing', false],
    ['existing', 'existing', true],
    ['existing', 'new', false],
    ['all', 'new', true],
    ['all', undefined, true],
    ['new', undefined, false], // unknown segment → never inject unverifiable directives
  ] as const)(
    'segment scope %s with context segment %s → included=%s',
    (scopeSegment, contextSegment, included) => {
      const instruction = makeInstruction({ scope: { customerSegment: scopeSegment } });
      const selected = selectApplicableInstructions([instruction], {
        intentType: 'create_estimate',
        customerSegment: contextSegment,
      });
      expect(selected.length).toBe(included ? 1 : 0);
    }
  );
});

describe('InMemoryStandingInstructionRepository', () => {
  let repo: InMemoryStandingInstructionRepository;

  beforeEach(() => {
    repo = new InMemoryStandingInstructionRepository();
  });

  it('round-trips create/findById and scopes reads by tenant', async () => {
    const created = await repo.create(makeInstruction());
    expect(await repo.findById(TENANT, created.id)).toMatchObject({
      id: created.id,
      instruction: created.instruction,
      active: true,
    });
    expect(await repo.findById('tenant-other', created.id)).toBeNull();
    expect(await repo.listAll('tenant-other')).toEqual([]);
  });

  it('listActive excludes deactivated rows; listAll keeps them, newest first', async () => {
    const older = await repo.create(
      makeInstruction({ createdAt: new Date('2026-06-01T00:00:00Z') })
    );
    const newer = await repo.create(
      makeInstruction({ createdAt: new Date('2026-06-15T00:00:00Z') })
    );
    await repo.deactivate(TENANT, older.id, 'user-2');

    expect((await repo.listActive(TENANT)).map((i) => i.id)).toEqual([newer.id]);
    expect((await repo.listAll(TENANT)).map((i) => i.id)).toEqual([newer.id, older.id]);
  });

  it('deactivate stamps deactivated_at/by; missing or already-inactive rows return null', async () => {
    const created = await repo.create(makeInstruction());
    const deactivated = await repo.deactivate(TENANT, created.id, 'user-2');
    expect(deactivated?.active).toBe(false);
    expect(deactivated?.deactivatedBy).toBe('user-2');
    expect(deactivated?.deactivatedAt).toBeInstanceOf(Date);

    expect(await repo.deactivate(TENANT, created.id, 'user-2')).toBeNull(); // already inactive
    expect(await repo.deactivate(TENANT, randomUUID(), 'user-2')).toBeNull(); // missing
  });

  it('enforces the 20-active cap per tenant; deactivation frees a slot', async () => {
    for (let i = 0; i < MAX_ACTIVE_STANDING_INSTRUCTIONS; i++) {
      await repo.create(makeInstruction());
    }
    await expect(repo.create(makeInstruction())).rejects.toBeInstanceOf(
      StandingInstructionLimitError
    );
    // Another tenant is unaffected by this tenant's cap.
    await expect(repo.create(makeInstruction({ tenantId: 'tenant-2' }))).resolves.toBeTruthy();

    const one = (await repo.listActive(TENANT))[0];
    await repo.deactivate(TENANT, one.id, 'user-1');
    await expect(repo.create(makeInstruction())).resolves.toBeTruthy();
  });
});

describe('createStandingInstruction / deactivateStandingInstruction services', () => {
  let repo: InMemoryStandingInstructionRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryStandingInstructionRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('creates with trimmed text and emits standing_instruction.created', async () => {
    const created = await createStandingInstruction(
      {
        tenantId: TENANT,
        instruction: '  Always add a fuel surcharge  ',
        scope: { intents: ['create_estimate'] },
        source: 'settings',
        createdBy: 'user-1',
        actorRole: 'owner',
      },
      repo,
      auditRepo
    );
    expect(created.instruction).toBe('Always add a fuel surcharge');
    expect(created.active).toBe(true);
    expect(created.source).toBe('settings');

    const audits = auditRepo.getAll();
    expect(
      audits.some(
        (a) => a.eventType === 'standing_instruction.created' && a.entityId === created.id
      )
    ).toBe(true);
  });

  it.each([
    ['blank instruction', { instruction: '   ' }],
    ['over-long instruction', { instruction: 'x'.repeat(501) }],
    ['invalid scope', { instruction: 'ok', scope: { amountCents: -1 } }],
  ])('rejects %s with ValidationError', async (_label, partial) => {
    await expect(
      createStandingInstruction(
        {
          tenantId: TENANT,
          instruction: 'ok',
          source: 'settings',
          createdBy: 'user-1',
          ...partial,
        },
        repo,
        auditRepo
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deactivates once, audits once, and is idempotent afterwards', async () => {
    const created = await createStandingInstruction(
      { tenantId: TENANT, instruction: 'No weekend discounts', source: 'settings', createdBy: 'user-1' },
      repo,
      auditRepo
    );
    const deactivated = await deactivateStandingInstruction(
      TENANT,
      created.id,
      repo,
      'user-2',
      auditRepo,
      'owner'
    );
    expect(deactivated.active).toBe(false);
    expect(deactivated.deactivatedBy).toBe('user-2');

    // Second call: same terminal state, no second audit event.
    const again = await deactivateStandingInstruction(TENANT, created.id, repo, 'user-2', auditRepo);
    expect(again.active).toBe(false);
    const deactivationEvents = auditRepo
      .getAll()
      .filter((a) => a.eventType === 'standing_instruction.deactivated');
    expect(deactivationEvents).toHaveLength(1);
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(
      deactivateStandingInstruction(TENANT, randomUUID(), repo, 'user-1', auditRepo)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
