/**
 * Google Local Services Ads (LSA) lead adapter — STUB.
 *
 * Maps an LSA "lead" webhook payload to the canonical InboundLead. Real LSA
 * delivery (the Local Services API, message-lead vs phone-lead types, OAuth)
 * is deferred until partner access lands; this is the mapping seam only.
 * Field paths follow the documented LSA lead shape with tolerant fallbacks.
 */
import {
  PartnerLeadAdapter,
  buildPartnerInboundLead,
  pickString,
} from './adapter';
import { InboundLead } from '@ai-service-os/shared';

export const googleLsaAdapter: PartnerLeadAdapter = {
  channel: 'google_lsa',
  displayName: 'Google Local Services',

  toInboundLead(raw: Record<string, unknown>): InboundLead {
    return buildPartnerInboundLead(
      'google_lsa',
      this.displayName,
      {
        firstName: pickString(raw, ['firstName', 'consumerFirstName', 'lead.consumerFirstName']),
        lastName: pickString(raw, ['lastName', 'consumerLastName', 'lead.consumerLastName']),
        primaryPhone: pickString(raw, [
          'phoneNumber',
          'consumerPhoneNumber',
          'lead.consumerPhoneNumber',
        ]),
        email: pickString(raw, ['email', 'consumerEmail', 'lead.consumerEmail']),
        serviceSummary: pickString(raw, ['jobType', 'categoryName', 'lead.jobType']),
        partnerLeadId: pickString(raw, ['leadId', 'lead.leadId', 'id']),
      },
      raw,
    );
  },
};
