/**
 * Postgres integration — migration 329 (D-045 one record per message).
 *
 * Pins the real columns and the upsert: a held or blocked text is one row
 * keyed by its dedupe key, a later outcome replaces it, a sent row is never
 * overwritten, and "did this reach a provider?" (`findByEntity`) never sees
 * a held or blocked text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgDispatchRepository, type RecordOutcomeInput } from '../../src/notifications/dispatch-repository';

describe('Postgres integration — message dispatch outcomes', () => {
  let pool: Pool;
  let repo: PgDispatchRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDispatchRepository(pool);
  });

  async function base(): Promise<Omit<RecordOutcomeInput, 'outcome'>> {
    const { tenantId } = await createTestTenant(pool);
    const jobId = crypto.randomUUID();
    return {
      tenantId,
      idempotencyKey: `thank_you_sms:${jobId}`,
      entityType: 'thank_you',
      entityId: jobId,
      channel: 'sms',
      recipient: '+15550001111',
      purpose: 'automated_nudge',
      customerId: crypto.randomUUID(),
      jobId,
    };
  }

  it('stores a blocked text with its reason, then replaces it with the sent outcome', async () => {
    const input = await base();

    const blocked = await repo.recordOutcome({
      ...input,
      outcome: { status: 'blocked', reason: 'send_failed', permanent: false, detail: 'Twilio 503' },
    });
    expect(blocked).toMatchObject({
      status: 'blocked',
      blockReason: 'send_failed',
      blockPermanent: false,
      errorMessage: 'Twilio 503',
      provider: 'none',
      customerId: input.customerId,
      jobId: input.jobId,
      purpose: 'automated_nudge',
    });

    const sent = await repo.recordOutcome({
      ...input,
      outcome: { status: 'sent', provider: 'twilio-sms', providerMessageId: 'SM1' },
    });
    expect(sent.id).toBe(blocked.id);
    expect(sent).toMatchObject({ status: 'sent', provider: 'sms-gateway', providerMessageId: 'SM1' });
    expect(sent.blockReason).toBeUndefined();
    expect(sent.errorMessage).toBeUndefined();
  });

  it('never overwrites a sent row', async () => {
    const input = await base();
    await repo.recordOutcome({ ...input, outcome: { status: 'sent', provider: 'twilio-sms', providerMessageId: 'SM2' } });

    const after = await repo.recordOutcome({
      ...input,
      outcome: { status: 'blocked', reason: 'channel_disabled', permanent: false },
    });

    expect(after).toMatchObject({ status: 'sent', providerMessageId: 'SM2' });
  });

  it('fills in the real receipt over a backfilled placeholder, but not the other way round', async () => {
    const input = await base();
    // A retry saw the claim already sent before the sending attempt recorded it.
    await repo.recordOutcome({ ...input, recipient: '', outcome: { status: 'sent', provider: 'unknown' } });

    const real = await repo.recordOutcome({
      ...input,
      outcome: { status: 'sent', provider: 'twilio-sms', providerMessageId: 'SM3' },
    });
    expect(real).toMatchObject({ status: 'sent', provider: 'sms-gateway', providerMessageId: 'SM3', recipient: '+15550001111' });

    const after = await repo.recordOutcome({ ...input, recipient: '', outcome: { status: 'sent', provider: 'unknown' } });
    expect(after).toMatchObject({ providerMessageId: 'SM3', recipient: '+15550001111' });
  });

  it('keeps a known number when a sent backfill replaces a held text', async () => {
    const input = await base();
    await repo.recordOutcome({ ...input, outcome: { status: 'scheduled', scheduledFor: new Date('2026-10-23T15:00:00Z') } });

    const after = await repo.recordOutcome({ ...input, recipient: '', outcome: { status: 'sent', provider: 'unknown' } });

    expect(after).toMatchObject({ status: 'sent', recipient: '+15550001111' });
  });

  it('never turns a later delivery failure back into sent', async () => {
    const input = await base();
    const sent = await repo.recordOutcome({
      ...input,
      outcome: { status: 'sent', provider: 'twilio-sms', providerMessageId: 'SM4' },
    });
    await repo.updateStatus(input.tenantId, sent.id, 'bounced', undefined, 'carrier rejected');

    const after = await repo.recordOutcome({ ...input, recipient: '', outcome: { status: 'sent', provider: 'unknown' } });

    expect(after).toMatchObject({ status: 'bounced', providerMessageId: 'SM4', errorMessage: 'carrier rejected' });
  });

  it('stores when a held text will go, and keeps it out of findByEntity', async () => {
    const input = await base();
    const opens = new Date('2026-10-23T15:00:00Z');

    const held = await repo.recordOutcome({ ...input, outcome: { status: 'scheduled', scheduledFor: opens } });

    expect(held.scheduledFor?.toISOString()).toBe(opens.toISOString());
    expect(await repo.findByEntity(input.tenantId, 'thank_you', input.entityId)).toEqual([]);
  });

  it('filters the list by status, customer and job', async () => {
    const input = await base();
    await repo.recordOutcome({ ...input, outcome: { status: 'blocked', reason: 'dnc', permanent: true } });
    const otherJob = crypto.randomUUID();
    await repo.recordOutcome({
      ...input,
      idempotencyKey: `thank_you_sms:${otherJob}`,
      entityId: otherJob,
      jobId: otherJob,
      outcome: { status: 'sent', provider: 'twilio-sms' },
    });

    const list = async (o: Parameters<typeof repo.listByTenant>[1]) =>
      (await repo.listByTenant(input.tenantId, o)).dispatches.map((d) => d.jobId);
    expect(await list({ status: 'blocked' })).toEqual([input.jobId]);
    expect(await list({ jobId: otherJob })).toEqual([otherJob]);
    expect((await list({ customerId: input.customerId })).sort()).toEqual([input.jobId, otherJob].sort());
  });

  it('the status CHECK rejects an unknown status (23514)', async () => {
    const input = await base();
    await expect(
      pool.query(
        `INSERT INTO message_dispatches (tenant_id, entity_type, entity_id, channel, recipient, provider, status)
         VALUES ($1, 'thank_you', $2, 'sms', '', 'none', 'lost')`,
        [input.tenantId, input.entityId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
