import { describe, it, expect } from 'vitest';
import {
  buildAiDisclosureText,
  discloseAiIdentity,
} from '../../../src/ai/skills/disclose-ai-identity';
import { InMemoryAuditRepository, type AuditEvent, type AuditRepository } from '../../../src/audit/audit';

describe('buildAiDisclosureText', () => {
  it('default EN copy says virtual assistant in plain words, never "AI"', () => {
    const out = buildAiDisclosureText({ businessName: "Bob's Plumbing" });
    expect(out).toBe("Just so you know, I'm a virtual assistant, not a live person.");
    expect(out).not.toMatch(/\bAI\b/);
  });

  it('default ES copy when language is es', () => {
    const out = buildAiDisclosureText({ businessName: 'Ace', language: 'es' });
    expect(out).toBe('Para que lo sepa, soy un asistente virtual, no una persona real.');
    expect(out).not.toMatch(/inteligencia artificial/);
  });

  it('per-tenant wording overrides the default (with {business_name})', () => {
    const out = buildAiDisclosureText({
      businessName: 'Ace',
      customText: 'Heads up — {business_name} uses an automated helper.',
    });
    expect(out).toBe('Heads up — Ace uses an automated helper.');
  });

  it('a blank business name in custom wording falls back to "our team"', () => {
    expect(buildAiDisclosureText({ businessName: '   ', customText: 'You reached {business_name}’s helper.' })).toBe(
      'You reached our team’s helper.',
    );
  });

  it('blank custom wording falls back to the default', () => {
    expect(buildAiDisclosureText({ businessName: 'Ace', customText: '   ' })).toBe(
      "Just so you know, I'm a virtual assistant, not a live person.",
    );
  });
});

describe('discloseAiIdentity', () => {
  const base = {
    tenantId: 't-1',
    businessName: 'Ace',
    voiceSessionId: 'vs-1',
    actorId: 'system:inbound-call',
  };

  it('returns the notice and writes NOTHING until the transport commits', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const r = discloseAiIdentity({ ...base, auditRepo });
    expect(r.disclosureText).toBe("Just so you know, I'm a virtual assistant, not a live person.");
    expect(await auditRepo.findByEntity('t-1', 'voice_session', 'vs-1')).toHaveLength(0);
  });

  it('commit appends exactly one ledger row, once, however often it is called', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const r = discloseAiIdentity({ ...base, auditRepo, channel: 'telephony', customText: 'Hi from {business_name}’s helper.' });
    await r.commitDisclosureLedger();
    await r.commitDisclosureLedger();
    const rows = await auditRepo.findByEntity('t-1', 'voice_session', 'vs-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: 't-1',
      actorId: 'system:inbound-call',
      actorRole: 'system',
      eventType: 'virtual_assistant_notice.played',
      entityType: 'voice_session',
      entityId: 'vs-1',
      correlationId: 'vs-1',
      metadata: {
        text: 'Hi from Ace’s helper.',
        wording: 'tenant',
        language: 'en',
        channel: 'telephony',
      },
    });
  });

  it('a failing ledger never rejects (the call must go on)', async () => {
    const failing = {
      create: async (_e: AuditEvent) => {
        throw new Error('db down');
      },
    } as unknown as AuditRepository;
    const r = discloseAiIdentity({ ...base, auditRepo: failing });
    await expect(r.commitDisclosureLedger()).resolves.toBeUndefined();
  });

  it('with no ledger wired the commit is a no-op and the notice still plays', async () => {
    const r = discloseAiIdentity(base);
    expect(r.disclosureText).not.toBe('');
    await expect(r.commitDisclosureLedger()).resolves.toBeUndefined();
  });
});
