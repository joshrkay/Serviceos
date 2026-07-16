import { describe, it, expect } from 'vitest';
import {
  auditEventToProductEvent,
  distinctIdFor,
  featureDomainFor,
  ALLOWLISTED_AUDIT_EVENT_TYPES,
} from '../../src/analytics/audit-event-mapping';
import { PRODUCT_EVENT_NAMES } from '../../src/analytics/product-events';
import { createAuditEvent, type AuditEvent } from '../../src/audit/audit';

function ev(over: Partial<AuditEvent> & { eventType: string }): AuditEvent {
  return createAuditEvent({
    tenantId: 't_1',
    actorId: over.actorId ?? 'clerk_owner',
    actorRole: over.actorRole ?? 'owner',
    eventType: over.eventType,
    entityType: over.entityType ?? 'proposal',
    entityId: over.entityId ?? 'ent_1',
    metadata: over.metadata,
  });
}

describe('auditEventToProductEvent', () => {
  it('returns null for an un-allowlisted eventType (deny-by-default)', () => {
    expect(auditEventToProductEvent(ev({ eventType: 'customer.updated' }))).toBeNull();
    expect(auditEventToProductEvent(ev({ eventType: 'sms.inbound.captured' }))).toBeNull();
  });

  it('maps proposal.approved with base props, feature_domain, and whitelisted metadata', () => {
    const pe = auditEventToProductEvent(
      ev({
        eventType: 'proposal.approved',
        entityType: 'proposal',
        entityId: 'p_1',
        actorId: 'clerk_owner',
        actorRole: 'owner',
        metadata: { proposalType: 'issue_invoice', status: 'approved', channel: 'sms_one_tap' },
      }),
    );
    expect(pe).not.toBeNull();
    expect(pe!.name).toBe('proposal_approved');
    expect(pe!.tenantId).toBe('t_1');
    expect(pe!.distinctId).toBe('clerk_owner');
    expect(pe!.properties).toMatchObject({
      entity_type: 'proposal',
      entity_id: 'p_1',
      actor_role: 'owner',
      actor_kind: 'human',
      feature_domain: 'proposal',
      audit_event_type: 'proposal.approved',
      proposal_type: 'issue_invoice',
      status: 'approved',
      channel: 'sms_one_tap',
    });
    // insertId is the audit event id (the dedup key).
    expect(typeof pe!.insertId).toBe('string');
    expect(pe!.insertId.length).toBeGreaterThan(0);
  });

  it('normalizes public_estimate.* to the estimate feature_domain', () => {
    const approved = auditEventToProductEvent(
      ev({ eventType: 'public_estimate.approved', entityType: 'estimate', actorRole: 'customer' }),
    );
    expect(approved!.name).toBe('estimate_approved');
    expect(approved!.properties.feature_domain).toBe('estimate');
    expect(featureDomainFor('public_estimate.declined')).toBe('estimate');
    expect(featureDomainFor('estimate.created')).toBe('estimate');
    expect(featureDomainFor('payment.recorded')).toBe('payment');
  });

  it('NEVER forwards PII / free-text / external-ref metadata', () => {
    // public_estimate.approved carries acceptedByName + ipAddress + userAgent.
    const approved = auditEventToProductEvent(
      ev({
        eventType: 'public_estimate.approved',
        entityType: 'estimate',
        actorRole: 'customer',
        metadata: {
          estimateNumber: 'EST-1001',
          totalCents: 250000,
          acceptedByName: 'Jane Homeowner',
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0 (iPhone)',
        },
      }),
    );
    const keys = Object.keys(approved!.properties);
    expect(approved!.properties).toMatchObject({ estimate_number: 'EST-1001', total_cents: 250000 });
    expect(keys).not.toContain('acceptedByName');
    expect(keys).not.toContain('accepted_by_name');
    expect(keys).not.toContain('ipAddress');
    expect(keys).not.toContain('ip_address');
    expect(keys).not.toContain('userAgent');
    expect(keys).not.toContain('user_agent');
    // and the raw values never appear under any key
    const values = Object.values(approved!.properties);
    expect(values).not.toContain('Jane Homeowner');
    expect(values).not.toContain('203.0.113.7');
  });

  it('drops free-text reason on rejections and declines', () => {
    const rejected = auditEventToProductEvent(
      ev({
        eventType: 'proposal.rejected',
        metadata: {
          proposalType: 'issue_invoice',
          status: 'rejected',
          rejectionReason: 'too_expensive',
          rejectionDetails: 'Customer said the quote for the master bath was way too high, call back Q3',
        },
      }),
    );
    expect(rejected!.properties).toMatchObject({ proposal_type: 'issue_invoice', status: 'rejected' });
    expect(Object.keys(rejected!.properties)).not.toContain('rejectionDetails');
    expect(Object.keys(rejected!.properties)).not.toContain('rejection_details');
    expect(Object.values(rejected!.properties)).not.toContain(
      'Customer said the quote for the master bath was way too high, call back Q3',
    );
  });

  it('defensively drops non-primitive metadata values', () => {
    const pe = auditEventToProductEvent(
      ev({
        eventType: 'appointment.booked',
        entityType: 'appointment',
        actorRole: 'system',
        metadata: { jobId: { nested: 'object' } as unknown as string },
      }),
    );
    expect(Object.keys(pe!.properties)).not.toContain('job_id');
  });
});

describe('distinctIdFor', () => {
  it('passes human actor ids through', () => {
    expect(distinctIdFor(ev({ eventType: 'proposal.approved', actorRole: 'owner', actorId: 'clerk_owner' }))).toBe(
      'clerk_owner',
    );
    expect(distinctIdFor(ev({ eventType: 'proposal.approved', actorRole: 'technician', actorId: 'clerk_tech' }))).toBe(
      'clerk_tech',
    );
  });

  it('collapses system / agent sentinels to a stable server id', () => {
    expect(
      distinctIdFor(ev({ eventType: 'payment.refunded', actorRole: 'system', actorId: 'system:stripe_webhook' })),
    ).toBe('server:system');
    expect(
      distinctIdFor(ev({ eventType: 'proposal.one_tap_approved', actorRole: 'system', actorId: 'one-tap-actor' })),
    ).toBe('server:system');
    expect(
      distinctIdFor(ev({ eventType: 'proposal.executed', actorRole: 'voice_agent', actorId: 'calling-agent' })),
    ).toBe('server:agent');
  });
});

describe('allowlist registry integrity', () => {
  it('every allowlisted name is a catalogued ProductEventName', () => {
    const catalog = new Set<string>(PRODUCT_EVENT_NAMES);
    for (const eventType of ALLOWLISTED_AUDIT_EVENT_TYPES) {
      const pe = auditEventToProductEvent(ev({ eventType, entityType: 'x', entityId: 'y' }));
      expect(pe, `allowlisted ${eventType} should map`).not.toBeNull();
      expect(catalog.has(pe!.name), `${pe!.name} must be in PRODUCT_EVENT_NAMES`).toBe(true);
    }
  });
});
