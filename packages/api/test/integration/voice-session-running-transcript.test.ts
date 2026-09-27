/**
 * #1406 D10 — in-app voice sessions the client never ended logged no
 * transcript (voice_sessions.transcript was written only by markEnded).
 * Pins the real SQL of PgVoiceSessionRepository.updateTranscript.
 *
 * Seam: PgVoiceSessionRepository (create / updateTranscript / markEnded /
 * findById) against real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgVoiceSessionRepository } from '../../src/voice/pg-voice-session';

describe('Postgres integration — running voice transcript (#1406 D10)', () => {
  let pool: Pool;
  let repo: PgVoiceSessionRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgVoiceSessionRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an open session carries its transcript so far', async () => {
    const id = randomUUID();
    await repo.create({ id, tenantId: tenant.tenantId, channel: 'inapp_voice', state: 'intent_capture' });

    await repo.updateTranscript(tenant.tenantId, id, ['caller: what is on today', 'agent: two jobs']);

    const row = await repo.findById(tenant.tenantId, id);
    expect(row?.transcript).toEqual(['caller: what is on today', 'agent: two jobs']);
    expect(row?.endedAt).toBeFalsy();
  });

  it('never rewrites the transcript of an ended session', async () => {
    const id = randomUUID();
    await repo.create({ id, tenantId: tenant.tenantId, channel: 'inapp_voice', state: 'intent_capture' });
    await repo.markEnded(tenant.tenantId, id, {
      endedAt: new Date(),
      endedReason: 'closed',
      outcome: 'completed',
      state: 'terminated',
      channel: 'inapp_voice',
      transcript: ['caller: final'],
    });

    await repo.updateTranscript(tenant.tenantId, id, ['caller: late write']);

    const row = await repo.findById(tenant.tenantId, id);
    expect(row?.transcript).toEqual(['caller: final']);
  });
});
