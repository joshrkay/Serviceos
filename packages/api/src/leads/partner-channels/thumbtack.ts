/**
 * Thumbtack lead adapter — STUB.
 *
 * Maps a Thumbtack lead webhook payload to the canonical InboundLead. Real
 * Thumbtack partner wiring (Partner API auth, lead/message webhooks) is
 * deferred; this is the mapping seam only. Field paths follow the documented
 * Thumbtack lead shape with tolerant fallbacks.
 */
import {
  PartnerLeadAdapter,
  buildPartnerInboundLead,
  pickString,
} from './adapter';
import { InboundLead } from '@ai-service-os/shared';

export const thumbtackAdapter: PartnerLeadAdapter = {
  channel: 'thumbtack',
  displayName: 'Thumbtack',

  toInboundLead(raw: Record<string, unknown>): InboundLead {
    return buildPartnerInboundLead(
      'thumbtack',
      this.displayName,
      {
        firstName: pickString(raw, ['firstName', 'customer.name', 'customerName']),
        primaryPhone: pickString(raw, ['phone', 'phoneNumber', 'customer.phoneNumber']),
        email: pickString(raw, ['email', 'customer.email']),
        serviceSummary: pickString(raw, ['categoryName', 'serviceCategory', 'title', 'description']),
        partnerLeadId: pickString(raw, ['leadID', 'leadId', 'requestPk', 'id']),
      },
      raw,
    );
  },
};
