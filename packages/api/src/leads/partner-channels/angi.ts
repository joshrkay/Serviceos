/**
 * Angi (Angie's List) lead adapter — STUB.
 *
 * Maps an Angi lead webhook payload to the canonical InboundLead. Real Angi
 * partner wiring (auth, lead acknowledgement callbacks) is deferred; this is
 * the mapping seam only. Field paths follow the documented Angi lead shape
 * with tolerant fallbacks.
 */
import {
  PartnerLeadAdapter,
  buildPartnerInboundLead,
  pickString,
} from './adapter';
import { InboundLead } from '@ai-service-os/shared';

export const angiAdapter: PartnerLeadAdapter = {
  channel: 'angi',
  displayName: 'Angi',

  toInboundLead(raw: Record<string, unknown>): InboundLead {
    return buildPartnerInboundLead(
      'angi',
      this.displayName,
      {
        firstName: pickString(raw, ['firstName', 'customer.firstName', 'contact.firstName']),
        lastName: pickString(raw, ['lastName', 'customer.lastName', 'contact.lastName']),
        primaryPhone: pickString(raw, ['phone', 'phoneNumber', 'customer.phone', 'contact.phone']),
        email: pickString(raw, ['email', 'customer.email', 'contact.email']),
        serviceSummary: pickString(raw, ['taskName', 'serviceName', 'category', 'description']),
        partnerLeadId: pickString(raw, ['leadId', 'oppId', 'id']),
      },
      raw,
    );
  },
};
