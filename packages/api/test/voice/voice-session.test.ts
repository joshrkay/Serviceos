import { describe, it, expect } from 'vitest';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
// NOTE: findByTenant tests are in this file (appended below).

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

  it('markEnded stamps endedAt + endedReason + outcome + final state', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-3', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    const at = new Date();
    const updated = await repo.markEnded(TENANT, 's-3', {
      endedAt: at,
      endedReason: 'caller_hangup',
      outcome: 'completed',
      state: 'terminated',
      channel: 'inapp_voice',
    });
    expect(updated?.endedAt).toEqual(at);
    expect(updated?.endedReason).toBe('caller_hangup');
    expect(updated?.outcome).toBe('completed');
    expect(updated?.state).toBe('terminated');
  });

  it('markEnded is idempotent: a second call returns null without overwriting', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-4', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    await repo.markEnded(TENANT, 's-4', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'no_intent',
      state: 'terminated',
      channel: 'inapp_voice',
    });
    const second = await repo.markEnded(TENANT, 's-4', {
      endedAt: new Date(),
      endedReason: 'session_ended',
      outcome: 'completed',
      state: 'terminated',
      channel: 'inapp_voice',
    });
    expect(second).toBeNull();
    const fetched = await repo.findById(TENANT, 's-4');
    expect(fetched?.outcome).toBe('no_intent');
    expect(fetched?.endedReason).toBe('caller_hangup');
  });

  it('markEnded UPSERTs when no create() row exists (race recovery)', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const at = new Date();
    const result = await repo.markEnded(TENANT, 's-race', {
      endedAt: at,
      endedReason: 'caller_hangup',
      outcome: 'dropped',
      state: 'terminated',
      channel: 'voice_inbound',
      callSid: 'CA-race',
    });
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe('dropped');
    expect(result?.callSid).toBe('CA-race');
    expect(result?.channel).toBe('voice_inbound');
    expect(result?.state).toBe('terminated');
    const fetched = await repo.findById(TENANT, 's-race');
    expect(fetched?.outcome).toBe('dropped');
  });

  it('markEnded returns null on tenant mismatch (does NOT upsert under wrong tenant)', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-5', tenantId: TENANT, channel: 'inapp_voice', state: 'idle' });
    const result = await repo.markEnded('other-tenant', 's-5', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'completed',
      state: 'terminated',
      channel: 'inapp_voice',
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

  it('markEnded persists transcript and customerId (migration 092 fields)', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 's-trans-1', tenantId: TENANT, channel: 'voice_inbound', state: 'idle' });
    const updated = await repo.markEnded(TENANT, 's-trans-1', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'completed',
      state: 'terminated',
      channel: 'voice_inbound',
      transcript: ['caller: I need AC repair', 'agent: I can help with that'],
      customerId: 'cust-uuid-1',
    });
    expect(updated?.transcript).toEqual(['caller: I need AC repair', 'agent: I can help with that']);
    expect(updated?.customerId).toBe('cust-uuid-1');
  });
});

describe('InMemoryVoiceSessionRepository.findByTenant', () => {
  const T1 = 'tenant-findbyten-1';
  const T2 = 'tenant-findbyten-2';

  it('returns empty array when no sessions exist for the tenant', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    expect(await repo.findByTenant(T1)).toEqual([]);
  });

  it('only returns sessions belonging to the requested tenant', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 'a', tenantId: T1, channel: 'voice_inbound', state: 'idle' });
    await repo.create({ id: 'b', tenantId: T2, channel: 'voice_inbound', state: 'idle' });

    const results = await repo.findByTenant(T1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('endedOnly=true filters to sessions with endedAt stamped', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 'open', tenantId: T1, channel: 'voice_inbound', state: 'idle' });
    await repo.create({ id: 'ended', tenantId: T1, channel: 'voice_inbound', state: 'idle' });
    await repo.markEnded(T1, 'ended', {
      endedAt: new Date(),
      endedReason: 'caller_hangup',
      outcome: 'completed',
      state: 'terminated',
      channel: 'voice_inbound',
    });

    const results = await repo.findByTenant(T1, { endedOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('ended');
  });

  it('customerId filter narrows results', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    await repo.create({ id: 'x', tenantId: T1, channel: 'voice_inbound', state: 'idle', customerId: 'cust-A' });
    await repo.create({ id: 'y', tenantId: T1, channel: 'voice_inbound', state: 'idle', customerId: 'cust-B' });

    const results = await repo.findByTenant(T1, { customerId: 'cust-A' });
    expect(results).toHaveLength(1);
    expect(results[0].customerId).toBe('cust-A');
  });

  it('respects limit and offset for pagination', async () => {
    const repo = new InMemoryVoiceSessionRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create({ id: `p-${i}`, tenantId: T1, channel: 'voice_inbound', state: 'idle' });
    }

    const page1 = await repo.findByTenant(T1, { limit: 2, offset: 0 });
    const page2 = await repo.findByTenant(T1, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    // No overlap between pages.
    const ids1 = new Set(page1.map((r) => r.id));
    const ids2 = new Set(page2.map((r) => r.id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });
});
