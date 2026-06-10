import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db';
import {
  claimProposalForExecutionCommand,
  completeProposalCommand,
  createProposalCommand,
  failProposalCommand,
  listProposals,
  makeApproveProposalCommand,
  rejectProposalCommand,
  undoProposalCommand,
} from '../../src/modules/proposals/engine';
import { executeProposalPayloadCommand } from '../../src/modules/proposals/handlers';
import { createTestDb, createTestTenant, waitFor, type TestDb } from './helpers';

const approveNow = makeApproveProposalCommand(0);
const approveSlow = makeApproveProposalCommand(5);

describe('proposal engine', () => {
  let env: TestDb;
  let tenantId: string;
  let userScope: { tenantId: string; actor: { type: 'user'; id: string } };
  let aiScope: { tenantId: string; actor: { type: 'ai'; id: string } };
  let systemScope: { tenantId: string; actor: { type: 'system'; id: string } };

  beforeAll(async () => {
    env = await createTestDb();
    const t = await createTestTenant(env.db);
    tenantId = t.tenantId;
    userScope = { tenantId, actor: { type: 'user', id: t.ownerUserId } };
    aiScope = { tenantId, actor: { type: 'ai', id: 'test-ai' } };
    systemScope = { tenantId, actor: { type: 'system', id: 'executor' } };
  });

  afterAll(async () => {
    await env.destroy();
  });

  function draft(summary: string, idempotencyKey?: string) {
    return env.bus.execute(createProposalCommand, aiScope, {
      type: 'create_customer',
      source: 'sms',
      payload: { name: `Customer ${summary}`, phone: `+1777${Math.floor(Math.random() * 1e7)}` },
      summary,
      confidenceBps: 9_000,
      idempotencyKey,
    });
  }

  it('rejects malformed payloads at the gate', async () => {
    await expect(
      env.bus.execute(createProposalCommand, aiScope, {
        type: 'create_customer',
        source: 'sms',
        payload: { name: '' }, // missing phone, empty name
        summary: 'bad',
      }),
    ).rejects.toThrow();
  });

  it('assigns sequential per-tenant short codes', async () => {
    const a = await draft('first');
    const b = await draft('second');
    expect(b.shortCode).toBe(a.shortCode + 1);
  });

  it('is idempotent per idempotency key', async () => {
    const first = await draft('idem', 'intent:msg-1');
    const second = await draft('idem again', 'intent:msg-1');
    expect(second.id).toBe(first.id);
  });

  it('full lifecycle: approve -> claim -> execute -> complete', async () => {
    const proposal = await draft('lifecycle');
    const approved = await env.bus.execute(approveNow, userScope, { proposalId: proposal.id });
    expect(approved.status).toBe('approved');

    const claimed = await waitFor(() =>
      env.bus.execute(claimProposalForExecutionCommand, systemScope, { proposalId: proposal.id }),
    );
    expect(claimed.status).toBe('executing');

    // Double claim no-ops (idempotent executor).
    const reclaim = await env.bus.execute(claimProposalForExecutionCommand, systemScope, {
      proposalId: proposal.id,
    });
    expect(reclaim).toBeNull();

    const result = await env.bus.execute(executeProposalPayloadCommand, systemScope, {
      type: claimed.type,
      payload: claimed.payload,
    });
    expect(result.customerId).toBeDefined();
    await env.bus.execute(completeProposalCommand, systemScope, { proposalId: proposal.id, result });

    const done = await listProposals(env.db, tenantId, 'executed');
    expect(done.map((p) => p.id)).toContain(proposal.id);

    const customer = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query('SELECT id FROM customers WHERE id = $1', [result.customerId]),
    );
    expect(customer.rows).toHaveLength(1);
  });

  it('undo inside the window prevents execution', async () => {
    const proposal = await draft('undoable');
    await env.bus.execute(approveSlow, userScope, { proposalId: proposal.id });

    // Claim before the undo deadline is refused.
    const early = await env.bus.execute(claimProposalForExecutionCommand, systemScope, {
      proposalId: proposal.id,
    });
    expect(early).toBeNull();

    const undone = await env.bus.execute(undoProposalCommand, userScope, { proposalId: proposal.id });
    expect(undone.status).toBe('undone');

    // Late-arriving execution job can never claim an undone proposal.
    const late = await env.bus.execute(claimProposalForExecutionCommand, systemScope, {
      proposalId: proposal.id,
    });
    expect(late).toBeNull();
  });

  it('rejected proposals are terminal', async () => {
    const proposal = await draft('rejectable');
    const rejected = await env.bus.execute(rejectProposalCommand, userScope, {
      proposalId: proposal.id,
      reason: 'not now',
    });
    expect(rejected.status).toBe('rejected');
    await expect(
      env.bus.execute(approveNow, userScope, { proposalId: proposal.id }),
    ).rejects.toThrow(/not found or not awaiting/);
  });

  it('execution failure is recorded, not silently swallowed', async () => {
    const proposal = await env.bus.execute(createProposalCommand, aiScope, {
      type: 'send_invoice',
      source: 'sms',
      payload: { invoiceId: '00000000-0000-0000-0000-000000000000' },
      summary: 'send a missing invoice',
    });
    await env.bus.execute(approveNow, userScope, { proposalId: proposal.id });
    const claimed = await waitFor(() =>
      env.bus.execute(claimProposalForExecutionCommand, systemScope, { proposalId: proposal.id }),
    );
    await expect(
      env.bus.execute(executeProposalPayloadCommand, systemScope, {
        type: claimed.type,
        payload: claimed.payload,
      }),
    ).rejects.toThrow();
    await env.bus.execute(failProposalCommand, systemScope, {
      proposalId: proposal.id,
      error: 'invoice not found',
    });
    const failed = await listProposals(env.db, tenantId, 'execution_failed');
    expect(failed.map((p) => p.id)).toContain(proposal.id);
  });
});
