import { describe, it, expect } from 'vitest';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';

const TENANT = 'tenant-1';

describe('InMemoryVoiceSessionRepository', () => {
  it('create returns a row with NULL terminal fields', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const row = await repo.create({
      id: 's-1',
      tenantId: TENANT,
      channel: 'inapp_voice',
      state: 'idle',
    });
    expect(row.id).toBe('s-1');
    expect(row.tenantId).toBe(TENANT);
    expect(row.channel).toBe('inapp_voice');
    expect(row.endedAt).toBeUndefined();
    expect(row.endedReason).toBeUndefined();
    expect(row.outcome).toBeUndefined();
    expect(row.callSid).toBeUndefined();
  });

  it('create persists callSid for telephony rows', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const row = await repo.create({
      id: 's-2',
      tenantId: TENANT,
      channel: 'voice_inbound',
      callSid: 'CA-123',
      state: 'greeting',
    });
    expect(row.callSid).toBe('CA-123');
  });

  it('markEnded stamps endedAt + endedReason + outcome', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-3', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    const at = new Date();
    const updated = await repo.markEnded(TENANT, 's-3', {
      endedAt: at,
      endedReason: 'caller_hangup',
      outcome: 'completed',
    });
    expect(updated?.endedAt).toEqual(at);
    expect(updated?.endedReason).toBe('caller_hangup');
    expect(updated?.outcome).toBe('completed');
  });

  it('markEnded is idempotent: a second call returns null without overwriting', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-4', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    await repo.markEnded(TENANT, 's-4', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'no_intent',
    });
    const second = await repo.markEnded(TENANT, 's-4', {
      endedAt: new Date(),
      endedReason: 'session_ended',
      outcome: 'completed',
    });
    expect(second).toBeNull();
    const fetched = await repo.findById(TENANT, 's-4');
    expect(fetched?.outcome).toBe('no_intent');
    expect(fetched?.endedReason).toBe('caller_hangup');
  });

  it('markEnded returns null on tenant mismatch', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-5', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    const result = await repo.markEnded('other-tenant', 's-5', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'completed',
    });
    expect(result).toBeNull();
  });

  it('findById returns null on tenant mismatch', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-6', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    expect(await repo.findById('other', 's-6')).toBeNull();
  });

  it('findById returns null for unknown id', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    expect(await repo.findById(TENANT, 'nope')).toBeNull();
  });
});
