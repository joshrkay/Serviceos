/**
 * Partner-channel adapter stubs (LSA / Angi / Thumbtack). Pins the mapping
 * seam: each adapter maps a representative partner payload to a valid
 * marketplace InboundLead with channel attribution + verbatim raw payload.
 */
import { describe, it, expect } from 'vitest';
import { inboundLeadSchema } from '@ai-service-os/shared';
import {
  getPartnerAdapter,
  listPartnerAdapters,
  googleLsaAdapter,
  angiAdapter,
  thumbtackAdapter,
  PARTNER_CHANNELS,
} from '../../src/leads/partner-channels';

describe('partner-channel adapters (stubs)', () => {
  it('registry resolves every declared channel and nothing else', () => {
    for (const channel of PARTNER_CHANNELS) {
      expect(getPartnerAdapter(channel)?.channel).toBe(channel);
    }
    expect(getPartnerAdapter('facebook')).toBeNull();
    expect(listPartnerAdapters()).toHaveLength(PARTNER_CHANNELS.length);
  });

  it('Google LSA payload → valid marketplace InboundLead', () => {
    const raw = {
      leadId: 'lsa-123',
      lead: { consumerFirstName: 'Dana', consumerLastName: 'Lee', consumerPhoneNumber: '5125550100' },
      jobType: 'AC repair',
    };
    const lead = googleLsaAdapter.toInboundLead(raw);
    expect(() => inboundLeadSchema.parse(lead)).not.toThrow();
    expect(lead.source).toBe('marketplace');
    expect(lead.firstName).toBe('Dana');
    expect(lead.primaryPhone).toBe('5125550100');
    expect(lead.attribution).toMatchObject({ partner_channel: 'google_lsa', partner_lead_id: 'lsa-123' });
    expect(lead.sourceDetail).toContain('Google Local Services');
    expect(lead.rawPayload).toEqual(raw);
  });

  it('Angi payload → valid marketplace InboundLead', () => {
    const raw = {
      oppId: 'angi-9',
      customer: { firstName: 'Ravi', lastName: 'Patel', phone: '5125550111', email: 'ravi@example.com' },
      taskName: 'Drain cleaning',
    };
    const lead = angiAdapter.toInboundLead(raw);
    expect(() => inboundLeadSchema.parse(lead)).not.toThrow();
    expect(lead.email).toBe('ravi@example.com');
    expect(lead.attribution).toMatchObject({ partner_channel: 'angi', partner_lead_id: 'angi-9' });
  });

  it('Thumbtack payload → valid marketplace InboundLead', () => {
    const raw = {
      leadID: 'tt-77',
      firstName: 'Mei',
      phone: '5125550122',
      categoryName: 'House cleaning',
    };
    const lead = thumbtackAdapter.toInboundLead(raw);
    expect(() => inboundLeadSchema.parse(lead)).not.toThrow();
    expect(lead.firstName).toBe('Mei');
    expect(lead.attribution).toMatchObject({ partner_channel: 'thumbtack', partner_lead_id: 'tt-77' });
  });

  it('throws a field-level error when the partner payload has no contact channel', () => {
    expect(() => googleLsaAdapter.toInboundLead({ leadId: 'x', jobType: 'AC' })).toThrow();
  });
});
