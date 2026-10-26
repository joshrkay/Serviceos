import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalSmsEventRepository, createProposalSmsEvent } from '../../src/proposals/sms/sms-event';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import { handleProposalSmsReply, SMS_REPLY_ACTOR_ID, type ProposalSmsReplyDeps } from '../../src/proposals/sms/reply-handler';
import type { ConfigPorts } from '../../src/learning/corrections/lesson-applicator';
import { recordCorrectionLessonsOnExecution } from '../../src/learning/corrections/record-on-execution';

/**
 * B1 — an SMS reply approves as the role its sender actually holds, against
 * real Postgres.
 *
 * The backup supervisor's mobile is an approval phone. The reply transport
 * used to call every action as 'owner', so a dispatcher backup's texted
 * "EDIT labor $200/hr" then "Y" stamped executed_by_role 'owner' and the
 * correction lesson rewrote tenant_settings.labor_rate_cents_per_hour —
 * authority the dashboard withholds from a dispatcher (PI-3).
 *
 * Pins, through the real repositories (users.role / clerk_user_id /
 * mobile_number / status, tenant_settings.owner_phone /
 * backup_supervisor_user_id, proposals.executed_by / executed_by_role):
 *   - the dispatcher backup's EDIT + Y approves as the dispatcher, and the
 *     executed edit records ZERO lessons and leaves the labor rate alone;
 *   - the owner phone is unchanged: the same EDIT + Y approves as the owner
 *     and the lesson cascades (so the first case is not vacuous);
 *   - a backup demoted to technician changes nothing by text.
 */
describe('Postgres integration — B1: SMS replies approve as the sender’s real role', () => {
  const OWNER_PHONE = '+15125550100';
  const BACKUP_PHONE = '+15125550111';
  const LABOR_RATE = 11500;
  const CUSTOMER = '9d3a7b1e-1111-4111-8111-111111111111';
  const labor = (cents: number) => ({ id: 'l1', description: 'Labor', category: 'labor', quantity: 1, unitPrice: cents });

  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let backupId: string;
  let backupSubject: string;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let settingsRepo: PgSettingsRepository;
  let userRepo: PgUserRepository;
  let auditRepo: PgAuditRepository;
  let smsEventRepo: PgProposalSmsEventRepository;
  let catalogRepo: PgCatalogItemRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let ports: ConfigPorts;
  const sent: { to: string; body: string }[] = [];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    userRepo = new PgUserRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    smsEventRepo = new PgProposalSmsEventRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);

    backupId = crypto.randomUUID();
    backupSubject = `clerk-backup-${backupId}`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number)
       VALUES ($1, $2, $3, $4, 'dispatcher', $5)`,
      [backupId, tenant.tenantId, backupSubject, `backup-${backupId}@example.com`, BACKUP_PHONE],
    );

    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Backup Co',
      ownerPhone: OWNER_PHONE,
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    await settingsRepo.update(tenant.tenantId, {
      backupSupervisorUserId: backupId,
      laborRateCentsPerHour: LABOR_RATE,
    });
    expect((await settingsRepo.findByTenant(tenant.tenantId))?.laborRateCentsPerHour).toBe(LABOR_RATE);

    // Real ports, mirroring app.ts: the labor rate lives in tenant_settings.
    ports = {
      async setLaborRateCents(tid, cents) {
        await settingsRepo.update(tid, { laborRateCentsPerHour: cents });
      },
      async setSkuPriceCents(tid, catalogItemId, cents) {
        await catalogRepo.update(tid, catalogItemId, { unitPriceCents: cents });
      },
      async setBannedPhrases() {
        /* no-op */
      },
      async setTemplateWeight() {
        /* no-op */
      },
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function deps(): ProposalSmsReplyDeps {
    return {
      proposalRepo,
      smsEventRepo,
      settingsRepo,
      userRepo,
      auditRepo,
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      // The LLM seam: "EDIT labor $200/hr", interpreted as a payload delta.
      interpretEdit: async () => ({ delta: { lineItems: [labor(20000)] } }),
    };
  }

  /** A rendered, still-reviewable estimate — the latest SMS reply target. */
  async function seedRenderedEstimate(): Promise<Proposal> {
    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: { customerId: CUSTOMER, lineItems: [labor(LABOR_RATE)] },
      summary: 'Estimate for the Garcia condenser',
      confidenceScore: 0.95,
      createdBy: tenant.userId,
    });
    const created = await proposalRepo.create(draft);
    await proposalRepo.updateStatus(tenant.tenantId, created.id, 'ready_for_review');
    await smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId: created.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Estimate for the Garcia condenser. Reply Y to approve, N to reject, EDIT to change.',
      }),
    );
    return created;
  }

  function reply(body: string, fromE164: string) {
    return handleProposalSmsReply(
      { tenantId: tenant.tenantId, fromE164, body, messageSid: `SM${crypto.randomUUID().replace(/-/g, '')}` },
      deps(),
    );
  }

  async function executeAndRecordLessons(proposalId: string) {
    const approved = (await proposalRepo.findById(tenant.tenantId, proposalId))!;
    await executionRepo.recordExecution({
      tenantId: tenant.tenantId,
      proposalId,
      executedBy: 'execution-worker',
      status: 'succeeded',
      executedAt: new Date(),
      executedPayload: approved.payload,
    });
    return recordCorrectionLessonsOnExecution(
      { tenantId: tenant.tenantId, proposalId },
      { proposalRepo, proposalExecutionRepo: executionRepo, settingsRepo, lessonRepo, catalogRepo, ports, auditRepo },
    );
  }

  async function row(proposalId: string) {
    const { rows } = await pool.query(
      `SELECT status, executed_by, executed_by_role, original_payload IS NOT NULL AS edited
         FROM proposals WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, proposalId],
    );
    return rows[0];
  }

  async function laborRate(): Promise<number | undefined> {
    return (await settingsRepo.findByTenant(tenant.tenantId))?.laborRateCentsPerHour;
  }

  it('a dispatcher backup’s EDIT then Y approves as the dispatcher and teaches the price book nothing', async () => {
    const proposal = await seedRenderedEstimate();

    expect(await reply('EDIT labor $200/hr', BACKUP_PHONE)).toMatchObject({ handled: true, reason: 'edited' });
    expect(await reply('Y', BACKUP_PHONE)).toMatchObject({ handled: true, reason: 'approved' });

    expect(await row(proposal.id)).toEqual({
      status: 'approved',
      executed_by: backupSubject,
      executed_by_role: 'dispatcher',
      edited: true,
    });

    const lessons = await executeAndRecordLessons(proposal.id);
    expect(lessons).toEqual([]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM correction_lessons WHERE tenant_id = $1`, [
      tenant.tenantId,
    ]);
    expect(rows[0].n).toBe(0);
    expect(await laborRate()).toBe(LABOR_RATE);
  });

  it('the owner phone is unchanged: the same EDIT then Y approves as the owner and the lesson cascades', async () => {
    const proposal = await seedRenderedEstimate();

    await reply('EDIT labor $200/hr', OWNER_PHONE);
    expect(await reply('Y', OWNER_PHONE)).toMatchObject({ handled: true, reason: 'approved' });

    expect(await row(proposal.id)).toMatchObject({
      status: 'approved',
      executed_by: SMS_REPLY_ACTOR_ID,
      executed_by_role: 'owner',
    });
    const lessons = await executeAndRecordLessons(proposal.id);
    expect(lessons.map((l) => l.lessonType)).toContain('labor_rate_changed');
    expect(await laborRate()).toBe(20000);
  });

  it('a backup demoted to technician changes nothing by text, and is told plainly', async () => {
    await pool.query(`UPDATE users SET role = 'technician' WHERE tenant_id = $1 AND id = $2`, [
      tenant.tenantId,
      backupId,
    ]);
    const proposal = await seedRenderedEstimate();
    sent.length = 0;

    expect(await reply('Y', BACKUP_PHONE)).toMatchObject({ handled: true, reason: 'approve_failed' });

    expect((await row(proposal.id)).status).toBe('ready_for_review');
    expect(sent).toEqual([
      {
        to: BACKUP_PHONE,
        body: 'You can’t approve, reject or change work by text, so nothing changed. Ask the owner to handle it.',
      },
    ]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'proposal.sms_reply_role_cannot_approve'`,
      [tenant.tenantId],
    );
    expect(rows[0].n).toBe(1);
  });
});
