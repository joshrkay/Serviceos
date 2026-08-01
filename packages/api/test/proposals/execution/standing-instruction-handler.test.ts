/**
 * UB-A2 — create_standing_instruction execution handler: inserts via the
 * UB-A1 repo (source 'proposal'), emits the standing_instruction.created
 * audit event, is idempotent via the resultEntityId convention, degrades to a
 * synthetic-id passthrough without a repo, and surfaces the 20-active cap as
 * a typed failure.
 */
import { describe, expect, it } from 'vitest';
import { CreateStandingInstructionExecutionHandler } from '../../../src/proposals/execution/standing-instruction-handler';
import {
  InMemoryStandingInstructionRepository,
  MAX_ACTIVE_STANDING_INSTRUCTIONS,
} from '../../../src/instructions/standing-instructions';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { createProposal, Proposal } from '../../../src/proposals/proposal';

function proposal(payload: Record<string, unknown>, overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: 't-1',
      proposalType: 'create_standing_instruction',
      payload,
      summary: 'Standing instruction',
      createdBy: 'u-1',
    }),
    ...overrides,
  };
}

const CONTEXT = { tenantId: 't-1', executedBy: 'owner-1' };

describe('CreateStandingInstructionExecutionHandler', () => {
  it('inserts the instruction with source proposal and emits the audit event', async () => {
    const repo = new InMemoryStandingInstructionRepository();
    const audit = new InMemoryAuditRepository();
    const handler = new CreateStandingInstructionExecutionHandler(repo, audit);

    const result = await handler.execute(
      proposal({
        instruction: 'Always add a $79 diagnostic fee to AC calls',
        scope: { tradeCategories: ['hvac'], amountCents: 7900 },
      }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const rows = await repo.listActive('t-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.resultEntityId);
    expect(rows[0].instruction).toBe('Always add a $79 diagnostic fee to AC calls');
    expect(rows[0].scope).toEqual({ tradeCategories: ['hvac'], amountCents: 7900 });
    expect(rows[0].source).toBe('proposal');
    expect(rows[0].createdBy).toBe('owner-1');

    const events = await audit.findByEntity(
      't-1',
      'standing_instruction',
      result.resultEntityId!,
    );
    const created = events.find((e) => e.eventType === 'standing_instruction.created');
    expect(created).toBeDefined();
    expect(created?.actorId).toBe('owner-1');
  });

  it('is idempotent: a proposal that already carries resultEntityId short-circuits (no second row)', async () => {
    const repo = new InMemoryStandingInstructionRepository();
    const handler = new CreateStandingInstructionExecutionHandler(repo);

    const first = await handler.execute(
      proposal({ instruction: 'Always include a fuel surcharge' }),
      CONTEXT,
    );
    expect(first.success).toBe(true);

    // Executor retry convention: the proposal row now carries resultEntityId.
    const retried = await handler.execute(
      proposal({ instruction: 'Always include a fuel surcharge' }, { resultEntityId: first.resultEntityId }),
      CONTEXT,
    );
    expect(retried.success).toBe(true);
    expect(retried.resultEntityId).toBe(first.resultEntityId);
    expect(await repo.listActive('t-1')).toHaveLength(1);
  });

  it('rejects an empty instruction and an invalid scope', async () => {
    const repo = new InMemoryStandingInstructionRepository();
    const handler = new CreateStandingInstructionExecutionHandler(repo);

    const empty = await handler.execute(proposal({ instruction: '   ' }), CONTEXT);
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/instruction/i);

    const badScope = await handler.execute(
      proposal({ instruction: 'valid', scope: { customerSegment: 'vip' } }),
      CONTEXT,
    );
    expect(badScope.success).toBe(false);
    expect(badScope.error).toMatch(/scope/i);
    expect(await repo.listActive('t-1')).toHaveLength(0);
  });

  it('surfaces the 20-active cap as a failure with the typed message', async () => {
    const repo = new InMemoryStandingInstructionRepository();
    const handler = new CreateStandingInstructionExecutionHandler(repo);
    for (let i = 0; i < MAX_ACTIVE_STANDING_INSTRUCTIONS; i++) {
      const r = await handler.execute(proposal({ instruction: `rule ${i}` }), CONTEXT);
      expect(r.success).toBe(true);
    }
    const overCap = await handler.execute(proposal({ instruction: 'one too many' }), CONTEXT);
    expect(overCap.success).toBe(false);
    expect(overCap.error).toMatch(/20 active standing instructions/);
  });

  it('degrades to a synthetic-id passthrough without a repo and reports not fully wired', async () => {
    const handler = new CreateStandingInstructionExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(proposal({ instruction: 'anything' }), CONTEXT);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
  });

  it('reports fully wired when the repo is present', () => {
    expect(
      new CreateStandingInstructionExecutionHandler(
        new InMemoryStandingInstructionRepository(),
      ).isFullyWired(),
    ).toBe(true);
  });
});
