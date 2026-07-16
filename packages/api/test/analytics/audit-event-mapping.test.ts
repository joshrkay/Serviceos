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

describe('broadened domains (jobs / customers / voice / ai)', () => {
  it('maps jobs and folds recurring_job into the job domain', () => {
    const created = auditEventToProductEvent(ev({ eventType: 'job.created', entityType: 'job', actorRole: 'user' }));
    expect(created!.name).toBe('job_created');
    expect(created!.properties.feature_domain).toBe('job');

    const recurring = auditEventToProductEvent(
      ev({ eventType: 'recurring_job.created', entityType: 'recurring_job', metadata: { customerId: 'c1', schedule: 'Every 2 weeks' } }),
    );
    expect(recurring!.name).toBe('recurring_job_created');
    expect(recurring!.properties.feature_domain).toBe('job');
    expect(recurring!.properties.schedule).toBe('Every 2 weeks');
    // customerId was not whitelisted for this event.
    expect(Object.keys(recurring!.properties)).not.toContain('customer_id');
  });

  it('drops the free-text reason on job.status_changed', () => {
    const pe = auditEventToProductEvent(
      ev({
        eventType: 'job.status_changed',
        entityType: 'job',
        metadata: { fromStatus: 'scheduled', toStatus: 'cancelled', backward: true, reason: 'customer no-showed, rude on phone' },
      }),
    );
    expect(pe!.properties).toMatchObject({ from_status: 'scheduled', to_status: 'cancelled' });
    expect(Object.keys(pe!.properties)).not.toContain('reason');
    expect(Object.values(pe!.properties)).not.toContain('customer no-showed, rude on phone');
  });

  it('folds leads into the customer domain and drops attribution + free-text', () => {
    const lead = auditEventToProductEvent(
      ev({
        eventType: 'lead.created',
        entityType: 'lead',
        metadata: { source: 'web', utmCampaign: 'spring', referrer: 'https://ads.example.com/?email=leak@x.com' },
      }),
    );
    expect(lead!.name).toBe('lead_created');
    expect(lead!.properties.feature_domain).toBe('customer');
    expect(lead!.properties.source).toBe('web');
    // attribution (which can embed a referrer URL / PII) never forwards.
    expect(Object.keys(lead!.properties)).not.toContain('referrer');
    expect(Object.keys(lead!.properties)).not.toContain('utm_campaign');
    expect(Object.values(lead!.properties)).not.toContain('https://ads.example.com/?email=leak@x.com');

    const lost = auditEventToProductEvent(
      ev({ eventType: 'lead.lost', entityType: 'lead', metadata: { fromStage: 'qualified', reason: 'went with a cheaper competitor' } }),
    );
    expect(lost!.properties).toMatchObject({ from_stage: 'qualified' });
    expect(Object.keys(lost!.properties)).not.toContain('reason');
  });

  it('maps voice/calls to the voice domain', () => {
    const call = auditEventToProductEvent(
      ev({ eventType: 'call.initiated', entityType: 'customer', actorRole: 'system', metadata: { callSid: 'CA123', conversationId: 'conv1' } }),
    );
    expect(call!.name).toBe('call_initiated');
    expect(call!.properties.feature_domain).toBe('voice');
    // opaque Twilio ids were not whitelisted.
    expect(Object.keys(call!.properties)).not.toContain('call_sid');

    const vm = auditEventToProductEvent(
      ev({ eventType: 'voicemail.received', entityType: 'lead', actorRole: 'system', metadata: { callSid: 'CA1', hasRecordingUrl: true } }),
    );
    expect(vm!.name).toBe('voicemail_received');
    expect(vm!.properties.feature_domain).toBe('voice');
    expect(vm!.properties.has_recording_url).toBe(true);
  });

  it('maps AI-agent activity to the ai domain', () => {
    const routed = auditEventToProductEvent(
      ev({
        eventType: 'unsupervised_proposal_routed',
        actorRole: 'system',
        actorId: 'system',
        metadata: { requestedRouting: 'queue_and_sms', effectiveRouting: 'escalate_to_oncall', channel: 'voice', escalated: true },
      }),
    );
    expect(routed!.name).toBe('unsupervised_proposal_routed');
    expect(routed!.properties.feature_domain).toBe('ai');
    expect(routed!.properties).toMatchObject({
      requested_routing: 'queue_and_sms',
      effective_routing: 'escalate_to_oncall',
      channel: 'voice',
      escalated: true,
    });
    expect(routed!.distinctId).toBe('server:system');

    const escalation = auditEventToProductEvent(
      ev({ eventType: 'escalation.requested', entityType: 'session', actorRole: 'system', actorId: 'sess_1', metadata: { reason: 'customer very upset about the invoice', outcome: 'assigned', assignedUserId: 'u1' } }),
    );
    expect(escalation!.name).toBe('escalation_requested');
    expect(escalation!.properties.feature_domain).toBe('ai');
    expect(escalation!.properties.outcome).toBe('assigned');
    // free-text reason + the assigned user id never forward.
    expect(Object.keys(escalation!.properties)).not.toContain('reason');
    expect(Object.keys(escalation!.properties)).not.toContain('assigned_user_id');
    expect(Object.values(escalation!.properties)).not.toContain('customer very upset about the invoice');
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
