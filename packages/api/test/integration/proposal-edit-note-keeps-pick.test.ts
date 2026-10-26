/**
 * R2-2 — a voice or text edit that ends as "your note is attached" keeps an
 * entity pick that landed while it ran, on real Postgres.
 *
 * Both edit paths read the row, then wait on the interpreter's LLM call. When
 * nothing can be applied (no delta, an invalid one, or the edit refused
 * because the row changed under it, A4-4) they stamp the instruction onto
 * sourceContext. That stamp was a whole-sourceContext write built from the
 * row read BEFORE the LLM call, so a pick that committed in between had its
 * picker put back and its resolution dropped. The note is now one key merged
 * into the row as it stands (PgProposalRepository.mergeSourceContext, a
 * single UPDATE with jsonb `||`).
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, PgProposalRepository and
 * PgAuditRepository, outside any request transaction (the voice and text
 * shape), and the REAL entity pick (resolveProposalEntity in a
 * PgTenantTransactionRunner) as the concurrent writer.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createTestTenant, getSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import { resolveProposalEntity } from '../../src/proposals/resolve-entity';
import { startVoiceEdit } from '../../src/ai/tasks/proposal-approval-task';
import { handleProposalSmsFallback, handleProposalSmsReply } from '../../src/proposals/sms/reply-handler';
import { InMemoryProposalSmsEventRepository, createProposalSmsEvent } from '../../src/proposals/sms/sms-event';
import type { SettingsRepository } from '../../src/settings/settings';

const CUST_A = '11111111-1111-4111-8111-111111111111';
const CUST_B = '22222222-2222-4222-8222-222222222222';
const OWNER_PHONE = '+15125550100';

const settingsRepo = {
  findByTenant: async () => ({ ownerPhone: OWNER_PHONE, escalationSettings: {} }),
} as unknown as SettingsRepository;

/** "Invoice Bob for the water heater": one ambiguous customer, annotate-only. */
function whichBob(tenantId: string, createdBy: string): Proposal {
  const customers = [
    { id: CUST_A, label: 'Bob Smith', score: 0.82 },
    { id: CUST_B, label: 'Bob Jones', score: 0.81 },
  ];
  return createProposal({
    tenantId,
    proposalType: 'voice_clarification',
    summary: 'Which customer? "Bob" matched 2 records',
    createdBy,
    payload: {
      transcript: 'invoice Bob for the water heater',
      reason: 'ambiguous_entity',
      entityReference: 'Bob',
      entityCandidates: customers,
    },
    sourceContext: {
      source: 'voice',
      transcript: 'invoice Bob for the water heater',
      entityKind: 'customer',
      entityReference: 'Bob',
      entityCandidates: customers.map((c) => ({ ...c, kind: 'customer' })),
    },
  });
}

describe('R2-2 — an edit recorded as a note keeps a pick that landed while it ran (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    pool = await getSharedTestDb();
  });

  /** A fresh tenant per case: the voice edit targets the one pending item there is. */
  async function seeded() {
    const tenant = await createTestTenant(pool);
    const repo = new PgProposalRepository(pool);
    const proposal = await repo.create(whichBob(tenant.tenantId, tenant.userId));
    const auditRepo = new PgAuditRepository(pool);
    // The concurrent writer: the real pick, on its own repository instance.
    const pick = () =>
      resolveProposalEntity(
        {
          tenantId: tenant.tenantId,
          proposalId: proposal.id,
          candidateId: CUST_B,
          actorId: tenant.userId,
          actorRole: 'owner',
        },
        {
          proposalRepo: new PgProposalRepository(pool),
          auditRepo,
          transactionRunner: new PgTenantTransactionRunner(pool),
        },
      );
    return { tenant, repo, proposal, auditRepo, pick };
  }

  async function row(id: string) {
    const { rows } = await pool.query<{
      status: string;
      payload: Record<string, unknown>;
      source_context: Record<string, unknown>;
    }>('SELECT status, payload, source_context FROM proposals WHERE id = $1', [id]);
    return rows[0];
  }

  /** The pick as it committed, with the note added: picker gone, Bob Jones resolved. */
  async function expectPickKeptWithNote(id: string, noteKey: string, instruction: string) {
    const r = await row(id);
    expect(r.payload.customerId).toBe(CUST_B);
    expect(r.payload.entityCandidates).toBeUndefined();
    expect(r.payload.transcript).toBe('invoice Bob for the water heater');
    expect(r.source_context.entityCandidates).toBeUndefined();
    expect(r.source_context.entityKind).toBeUndefined();
    expect(r.source_context.resolvedEntity).toMatchObject({ id: CUST_B, kind: 'customer' });
    expect(r.source_context.source).toBe('voice');
    expect(r.source_context[noteKey]).toMatchObject({ instruction });
    expect(r.status).toBe('ready_for_review');
  }

  it('mergeSourceContext adds the keys to the row as it stands, in one write', async () => {
    const { tenant, repo, proposal } = await seeded();
    // Another writer replaced sourceContext after this caller's read.
    await repo.update(tenant.tenantId, proposal.id, { sourceContext: { source: 'voice', resolvedEntity: { id: CUST_B } } });
    const before = (await repo.findById(tenant.tenantId, proposal.id))!;

    const merged = await repo.mergeSourceContext(tenant.tenantId, proposal.id, {
      pendingVoiceEditRequest: { instruction: 'make it nicer', receivedAt: '2026-10-23T00:00:00.000Z' },
    });

    const expected = {
      source: 'voice',
      resolvedEntity: { id: CUST_B },
      pendingVoiceEditRequest: { instruction: 'make it nicer', receivedAt: '2026-10-23T00:00:00.000Z' },
    };
    expect(merged!.sourceContext).toEqual(expected);
    expect((await row(proposal.id)).source_context).toEqual(expected);
    expect(merged!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(merged!.payload).toEqual(before.payload);
  });

  it('mergeSourceContext starts from nothing on a row with no sourceContext, and never touches another tenant', async () => {
    const { tenant, repo } = await seeded();
    const bare = await repo.create(
      createProposal({
        tenantId: tenant.tenantId,
        proposalType: 'voice_clarification',
        summary: 'bare',
        createdBy: tenant.userId,
        payload: { transcript: 'x', reason: 'ambiguous_entity' },
      }),
    );
    await pool.query('UPDATE proposals SET source_context = NULL WHERE id = $1', [bare.id]);

    const merged = await repo.mergeSourceContext(tenant.tenantId, bare.id, { pendingSmsEditRequest: { instruction: 'n' } });
    expect(merged!.sourceContext).toEqual({ pendingSmsEditRequest: { instruction: 'n' } });

    const other = await createTestTenant(pool);
    expect(await repo.mergeSourceContext(other.tenantId, bare.id, { stray: true })).toBeNull();
    expect((await row(bare.id)).source_context).toEqual({ pendingSmsEditRequest: { instruction: 'n' } });
  });

  it('voice: a pick that commits between the edit\'s read and its write refuses the edit; the note keeps the pick', async () => {
    const { tenant, repo, proposal, auditRepo, pick } = await seeded();
    const instruction = 'add the filter too';
    const realUpdateIfUnchanged = repo.updateIfUnchanged.bind(repo);
    vi.spyOn(repo, 'updateIfUnchanged').mockImplementationOnce(async (...args) => {
      await pick();
      return realUpdateIfUnchanged(...args);
    });

    const result = await startVoiceEdit(
      {
        proposalRepo: repo,
        auditRepo,
        settingsRepo,
        smsEventRepo: new InMemoryProposalSmsEventRepository(),
        editInterpreter: async () => ({ delta: { transcript: 'invoice Bob for the water heater and the filter' } }),
      },
      { tenantId: tenant.tenantId, sessionId: 'sess-r2-2', ownerSession: true, reference: 'it', instruction },
    );

    expect(result.outcome).toBe('edit_recorded');
    await expectPickKeptWithNote(proposal.id, 'pendingVoiceEditRequest', instruction);
  });

  it('voice: a pick that commits while the instruction is interpreted is kept when nothing could be applied', async () => {
    const { tenant, repo, proposal, auditRepo, pick } = await seeded();
    const instruction = 'make it nicer somehow';

    const result = await startVoiceEdit(
      {
        proposalRepo: repo,
        auditRepo,
        settingsRepo,
        smsEventRepo: new InMemoryProposalSmsEventRepository(),
        editInterpreter: async () => {
          await pick();
          return null;
        },
      },
      { tenantId: tenant.tenantId, sessionId: 'sess-r2-2', ownerSession: true, reference: 'it', instruction },
    );

    expect(result.outcome).toBe('edit_recorded');
    await expectPickKeptWithNote(proposal.id, 'pendingVoiceEditRequest', instruction);
  });

  it('text: a pick that commits while the instruction is interpreted is kept when nothing could be applied', async () => {
    const { tenant, repo, proposal, auditRepo, pick } = await seeded();
    const smsEventRepo = new InMemoryProposalSmsEventRepository();
    await smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId: proposal.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Which Bob? Reply Y to approve, N to reject, EDIT to change.',
      }),
    );

    const deps = {
      proposalRepo: repo,
      smsEventRepo,
      settingsRepo,
      auditRepo,
      sendSms: async () => undefined,
      interpretEdit: async () => {
        await pick();
        return null;
      },
    };
    const text = (body: string, messageSid: string) => ({ tenantId: tenant.tenantId, fromE164: OWNER_PHONE, body, messageSid });

    // "EDIT" opens the session; the next text is the instruction.
    await handleProposalSmsReply(text('EDIT', 'SM-r2-2-a'), deps);
    const result = await handleProposalSmsFallback(text('make it nicer somehow', 'SM-r2-2-b'), deps);

    expect(result).toMatchObject({ handled: true, reason: 'edit_recorded' });
    await expectPickKeptWithNote(proposal.id, 'pendingSmsEditRequest', 'make it nicer somehow');
  });
});
