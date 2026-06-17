import { describe, it, expect, beforeEach } from 'vitest';
import { findOrCreateLeadByPhone } from '../../../src/ai/skills/find-or-create-lead';
import { InMemoryLeadRepository } from '../../../src/leads/lead';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { Lead, LeadRepository } from '../../../src/leads/lead';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('findOrCreateLeadByPhone', () => {
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('creates a phone_call lead when the caller is unknown', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
    });

    expect(result.status).toBe('created');
    expect(result.lead.source).toBe('phone_call');
    expect(result.lead.stage).toBe('new');
    expect(result.lead.primaryPhone).toBe('+15125550100');
    expect(result.lead.firstName).toBe('');
    expect(result.lead.createdBy).toBe('system:inbound-call');
    expect(result.lead.sourceDetail).toContain('Inbound call from');

    const audits = auditRepo.getAll();
    expect(audits).toHaveLength(1);
    expect(audits[0].eventType).toBe('lead.created');
    expect(audits[0].actorId).toBe('system:inbound-call');
    expect(audits[0].actorRole).toBe('system');
    expect(audits[0].metadata).toMatchObject({
      source: 'phone_call',
      via: 'inbound_call_skill',
    });
  });

  it('returns the existing lead when called twice with the same number', async () => {
    const first = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
    });

    const second = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
    });

    expect(second.status).toBe('found');
    expect(second.leadId).toBe(first.leadId);
    expect(leadRepo.getAll()).toHaveLength(1);
    // Only the first call writes an audit event.
    expect(auditRepo.getAll()).toHaveLength(1);
  });

  it('treats different phone formattings as the same number', async () => {
    const first = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+1 (512) 555-0100',
      leadRepo,
      auditRepo,
    });

    const second = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '5125550100',
      leadRepo,
    });

    expect(second.status).toBe('found');
    expect(second.leadId).toBe(first.leadId);
    expect(leadRepo.getAll()).toHaveLength(1);
  });

  it('isolates leads across tenants', async () => {
    const a = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
    });
    const b = await findOrCreateLeadByPhone({
      tenantId: '22222222-2222-2222-2222-222222222222',
      fromPhone: '+15125550100',
      leadRepo,
    });

    expect(b.status).toBe('created');
    expect(b.leadId).not.toBe(a.leadId);
    expect(leadRepo.getAll()).toHaveLength(2);
  });

  it('survives a 23505 race by re-fetching the existing row', async () => {
    // Seed a lead so the fallback findByPhoneNormalized has something.
    const seeded = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
    });

    // Wrap leadRepo so the next findByPhoneNormalized returns null once
    // (simulating the race where SELECT misses), then create() throws
    // 23505 (the partial unique index catching the racing insert).
    let firstFindCall = true;
    const racingRepo: LeadRepository = {
      ...leadRepo,
      create: async () => {
        const err = new Error('duplicate key value violates unique constraint');
        (err as Error & { code: string }).code = '23505';
        throw err;
      },
      findByPhoneNormalized: async (tenantId, normalized) => {
        if (firstFindCall) {
          firstFindCall = false;
          return null;
        }
        return leadRepo.findByPhoneNormalized(tenantId, normalized);
      },
      findById: leadRepo.findById.bind(leadRepo),
      findByTenant: leadRepo.findByTenant.bind(leadRepo),
      listWithMeta: leadRepo.listWithMeta.bind(leadRepo),
      update: leadRepo.update.bind(leadRepo),
    };

    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo: racingRepo,
    });

    expect(result.status).toBe('found');
    expect(result.leadId).toBe(seeded.leadId);
  });

  it('still creates a lead for very short phone numbers (no dedupe)', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '12345',
      leadRepo,
    });
    expect(result.status).toBe('created');
    expect(result.lead.primaryPhone).toBe('12345');
  });

  it('preserves the original raw phone on the created lead', async () => {
    const raw = '+1 (512) 555-0100';
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: raw,
      leadRepo,
    });
    expect(result.lead.primaryPhone).toBe(raw);
  });

  it('honors source / channelLabel / auditVia overrides (SMS capture)', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
      systemActorId: 'system:sms-capture',
      source: 'sms',
      channelLabel: 'text',
      auditVia: 'sms_capture',
    });

    expect(result.status).toBe('created');
    expect(result.lead.source).toBe('sms');
    expect(result.lead.sourceDetail).toContain('Inbound text from');
    expect(result.lead.sourceDetail).not.toContain('Inbound call');

    const audit = auditRepo.getAll()[0];
    expect(audit.metadata).toMatchObject({ source: 'sms', via: 'sms_capture' });
  });

  it('honors a custom systemActorId override', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
      systemActorId: 'system:test',
    });
    expect(result.lead.createdBy).toBe('system:test');
    expect(auditRepo.getAll()[0].actorId).toBe('system:test');
  });

  it('surfaces non-23505 errors instead of swallowing them', async () => {
    const repo: LeadRepository = {
      ...leadRepo,
      create: async () => {
        throw new Error('connection lost');
      },
      findById: leadRepo.findById.bind(leadRepo),
      findByTenant: leadRepo.findByTenant.bind(leadRepo),
      findByPhoneNormalized: leadRepo.findByPhoneNormalized.bind(leadRepo),
      listWithMeta: leadRepo.listWithMeta.bind(leadRepo),
      update: leadRepo.update.bind(leadRepo),
    };

    await expect(
      findOrCreateLeadByPhone({
        tenantId: TENANT,
        fromPhone: '+15125550100',
        leadRepo: repo,
      })
    ).rejects.toThrow('connection lost');
  });
});
