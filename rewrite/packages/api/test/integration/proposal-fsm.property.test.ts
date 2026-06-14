import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TERMINAL_PROPOSAL_STATUSES, type ProposalStatus } from '@rivet/contracts';
import { withTenantTransaction } from '../../src/core/db';
import {
  claimProposalForExecutionCommand,
  completeProposalCommand,
  createProposalCommand,
  failProposalCommand,
  makeApproveProposalCommand,
  rejectProposalCommand,
  undoProposalCommand,
} from '../../src/modules/proposals/engine';
import { createTestDb, createTestTenant, type TestDb } from './helpers';

/**
 * Property-based test of the proposal state machine as enforced by the
 * database (guarded UPDATEs): no random sequence of operations may ever
 * produce an invalid transition, leave a terminal status, or execute twice.
 */

type Op = 'approve' | 'reject' | 'undo' | 'claim' | 'complete' | 'fail';
const opArb = fc.constantFrom<Op>('approve', 'reject', 'undo', 'claim', 'complete', 'fail');

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  ready_for_review: ['approved', 'rejected'],
  approved: ['executing', 'undone'],
  executing: ['executed', 'execution_failed'],
  executed: [],
  execution_failed: [],
  rejected: [],
  undone: [],
};

describe('proposal FSM properties', () => {
  let env: TestDb;
  let tenantId: string;
  let userScope: { tenantId: string; actor: { type: 'user'; id: string } };
  let systemScope: { tenantId: string; actor: { type: 'system'; id: string } };
  const approve = makeApproveProposalCommand(0);

  beforeAll(async () => {
    env = await createTestDb();
    const t = await createTestTenant(env.db);
    tenantId = t.tenantId;
    userScope = { tenantId, actor: { type: 'user', id: t.ownerUserId } };
    systemScope = { tenantId, actor: { type: 'system', id: 'fsm-test' } };
  });

  afterAll(async () => {
    await env.destroy();
  });

  async function readStatus(proposalId: string): Promise<ProposalStatus> {
    const { rows } = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query('SELECT status FROM proposals WHERE id = $1', [proposalId]),
    );
    return rows[0].status as ProposalStatus;
  }

  async function applyOp(proposalId: string, op: Op): Promise<void> {
    const swallowConflict = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // Guarded transitions refuse invalid ops; that's the point.
      }
    };
    switch (op) {
      case 'approve':
        return swallowConflict(() => env.bus.execute(approve, userScope, { proposalId }));
      case 'reject':
        return swallowConflict(() => env.bus.execute(rejectProposalCommand, userScope, { proposalId }));
      case 'undo':
        return swallowConflict(() => env.bus.execute(undoProposalCommand, userScope, { proposalId }));
      case 'claim':
        return swallowConflict(() =>
          env.bus.execute(claimProposalForExecutionCommand, systemScope, { proposalId }),
        );
      case 'complete':
        return swallowConflict(() =>
          env.bus.execute(completeProposalCommand, systemScope, { proposalId, result: {} }),
        );
      case 'fail':
        return swallowConflict(() =>
          env.bus.execute(failProposalCommand, systemScope, { proposalId, error: 'x' }),
        );
    }
  }

  it('no operation sequence can corrupt the state machine', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        const proposal = await env.bus.execute(
          createProposalCommand,
          { tenantId, actor: { type: 'ai', id: 'fsm' } },
          {
            type: 'create_customer',
            source: 'system',
            payload: { name: 'FSM', phone: `+1666${Math.floor(Math.random() * 1e7)}` },
            summary: 'fsm property run',
          },
        );

        let previous: ProposalStatus = proposal.status;
        for (const op of ops) {
          await applyOp(proposal.id, op);
          const current = await readStatus(proposal.id);
          if (current !== previous) {
            expect(VALID_TRANSITIONS[previous]).toContain(current);
          }
          if (TERMINAL_PROPOSAL_STATUSES.includes(previous)) {
            expect(current).toBe(previous);
          }
          previous = current;
        }
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it('parallel approvals and claims admit exactly one execution', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (concurrency) => {
        const proposal = await env.bus.execute(
          createProposalCommand,
          { tenantId, actor: { type: 'ai', id: 'fsm' } },
          {
            type: 'create_customer',
            source: 'system',
            payload: { name: 'Race', phone: `+1555${Math.floor(Math.random() * 1e7)}` },
            summary: 'race property run',
          },
        );
        await env.bus.execute(approve, userScope, { proposalId: proposal.id });
        const claims = await Promise.all(
          Array.from({ length: concurrency }, () =>
            env.bus
              .execute(claimProposalForExecutionCommand, systemScope, { proposalId: proposal.id })
              .catch(() => null),
          ),
        );
        const successes = claims.filter((claim) => claim !== null);
        expect(successes).toHaveLength(1);
      }),
      { numRuns: 10 },
    );
  }, 120_000);
});
