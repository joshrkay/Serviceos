/**
 * P18-001 — `create_customer` execution handler.
 *
 * Wired as the `create_customer` handler via `createExecutionHandlerRegistry`
 * when `customerRepo` is present. On approval, this handler:
 *
 *   1. Splits the proposal `name` into firstName/lastName the same
 *      way the customer routes do.
 *   2. Calls `createCustomer()` so the existing dedup + audit-event
 *      writers fire (one `customer.created` audit row per execution).
 *   3. Emits a SECOND audit row tagged `proposal.executed` with
 *      correlationId set to the voice session id, so investigators
 *      can join `audit_events` → `voice_sessions` in a single query
 *      (acceptance criterion AC-4).
 *
 * The handler degrades to a synthetic-id passthrough when no
 * CustomerRepository is wired — same pattern as the other voice-
 * extended handlers — so existing in-memory tests keep working.
 */

import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  CustomerRepository,
  PreferredChannel,
  createCustomer,
} from '../../customers/customer';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { LocationRepository, createLocation } from '../../locations/location';

/**
 * Parse the free-text address the caller spoke into the structured shape
 * `service_locations` requires. Returns `undefined` unless ALL FOUR
 * NOT NULL columns (street1, city, state, postal_code) are recoverable —
 * the same completeness gate `add_service_location` and lead conversion
 * already enforce (`refineCompleteAddress` in leads/enums.ts).
 *
 * We deliberately do NOT fabricate placeholders for missing parts the way
 * the web new-customer form does (`city: 'Unknown', state: 'NA',
 * postalCode: '00000'` in CustomersPage.tsx). Writing invented values into
 * the CRM is worse than leaving the verbatim address on the proposal
 * payload for a human to complete.
 *
 * Handles the shapes speech-to-text actually produces:
 *   "412 Oak Street, Scottsdale, AZ 85254"
 *   "412 Oak Street, Scottsdale, AZ, 85254"
 */
export function parseSpokenAddress(text: string):
  | { street1: string; city: string; state: string; postalCode: string }
  | undefined {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;

  const street1 = parts[0];
  const city = parts[1];

  // Remaining parts hold state and postal code, either together
  // ("AZ 85254") or split across two comma-separated fields.
  const tail = parts.slice(2).join(' ').trim();
  const match = /^([A-Za-z][A-Za-z .]*?)\s+(\d{5}(?:-\d{4})?)$/.exec(tail);
  if (!match) return undefined;

  const state = match[1].trim();
  const postalCode = match[2].trim();
  if (!street1 || !city || !state || !postalCode) return undefined;
  return { street1, city, state, postalCode };
}

/**
 * Split a single `name` field into firstName + lastName. Mirrors what
 * the manual customer routes do: split on the first whitespace, treat
 * everything after as the last name. A single-token name is treated
 * as a `firstName` (validateCustomerInput accepts a firstName-only
 * record; we don't fabricate a `companyName`).
 */
export function splitName(name: string): {
  firstName: string;
  lastName: string;
  companyName?: string;
} {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { firstName: '', lastName: '' };
  }
  const idx = trimmed.indexOf(' ');
  if (idx === -1) {
    // Single token → ambiguous; we keep it as firstName (validation
    // accepts a firstName-only customer) and don't fabricate a
    // companyName.
    return { firstName: trimmed, lastName: '' };
  }
  return {
    firstName: trimmed.slice(0, idx).trim(),
    lastName: trimmed.slice(idx + 1).trim(),
  };
}

export class CreateCustomerVoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';

  constructor(
    private readonly customerRepo?: CustomerRepository,
    private readonly auditRepo?: AuditRepository,
    // Optional: when wired, a COMPLETE spoken address on the payload is
    // promoted to a primary service_location linked to the new customer.
    // `customers` has no address column — a linked location is the only
    // place an address can live.
    private readonly locationRepo?: LocationRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without the
  // customer repo; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.customerRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
      return { success: false, error: 'Payload must include a non-empty name' };
    }

    // Repo not wired (in-memory unit test path) → preserve the existing
    // synthetic-id passthrough behavior so legacy tests still pass.
    if (!this.customerRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const { firstName, lastName, companyName } = splitName(payload.name);
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const phone = typeof payload.phone === 'string' ? payload.phone : undefined;
    const notes = typeof payload.notes === 'string' ? payload.notes : undefined;
    const smsConsent =
      typeof payload.smsConsent === 'boolean' ? payload.smsConsent : false;

    // Voice provenance metadata, when present, drives `preferredChannel`.
    // Phone-only callers get 'phone' as the preferred channel; email-
    // only callers get 'email'. Default 'none' so we never imply consent.
    const preferredChannel: PreferredChannel = phone
      ? 'phone'
      : email
      ? 'email'
      : 'none';

    let createdCustomerId: string;
    try {
      const customer = await createCustomer(
        {
          tenantId: context.tenantId,
          firstName,
          lastName,
          ...(companyName ? { companyName } : {}),
          ...(phone ? { primaryPhone: phone } : {}),
          ...(email ? { email } : {}),
          preferredChannel,
          smsConsent,
          ...(notes ? { communicationNotes: notes } : {}),
          createdBy: context.executedBy,
          actorRole: 'voice_agent',
        },
        this.customerRepo,
        this.auditRepo,
      );
      createdCustomerId = customer.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create customer: ${msg}` };
    }

    // The spoken address. `customers` has no address column, so the only
    // destination is a linked service_location row — created here as the
    // customer's primary location when the free text parses into all four
    // NOT NULL fields. Best-effort by design (same posture as the audit
    // join-row below): an incomplete address, or a location-write failure,
    // must never unwind a customer the approver already said yes to. The
    // verbatim text stays on `proposal.payload.address` either way, so
    // nothing is silently lost.
    const address = typeof payload.address === 'string' ? payload.address.trim() : '';
    if (address.length > 0 && this.locationRepo) {
      const parsed = parseSpokenAddress(address);
      if (parsed) {
        try {
          await createLocation(
            {
              tenantId: context.tenantId,
              customerId: createdCustomerId,
              ...parsed,
              isPrimary: true,
            },
            this.locationRepo,
            this.auditRepo,
            context.executedBy,
            'voice_agent',
          );
        } catch {
          // Swallowed on purpose — see comment above.
        }
      }
    }

    // Voice session correlation: AC-4 requires the audit event tying
    // the executed proposal to the voice session. The session id rides
    // either in payload.voice.sessionId or in proposal.sourceContext.
    // WS11 — kept deliberately alongside the executor's own atomic
    // `proposal.executed` row (entityType 'proposal'): this one is the
    // customer-entity join-row for voice-session queries, best-effort by design.
    if (this.auditRepo) {
      const correlationId = readSessionCorrelation(proposal);
      try {
        const event = createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'voice_agent',
          eventType: 'proposal.executed',
          entityType: 'customer',
          entityId: createdCustomerId,
          ...(correlationId ? { correlationId } : {}),
          metadata: {
            proposalId: proposal.id,
            proposalType: 'create_customer',
            source: 'voice',
          },
        });
        await this.auditRepo.create(event);
      } catch {
        // Audit failures must not unwind a successful customer create.
        // The createCustomer call already emitted `customer.created`;
        // the second event is a join-row and best-effort.
      }
    }

    return { success: true, resultEntityId: createdCustomerId };
  }
}

function readSessionCorrelation(proposal: Proposal): string | undefined {
  const payloadVoice =
    typeof proposal.payload === 'object' && proposal.payload !== null
      ? (proposal.payload as Record<string, unknown>).voice
      : undefined;
  if (typeof payloadVoice === 'object' && payloadVoice !== null) {
    const sid = (payloadVoice as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  const ctx = proposal.sourceContext;
  if (ctx) {
    const corr = (ctx as Record<string, unknown>).correlationId;
    if (typeof corr === 'string' && corr.length > 0) return corr;
    const sid = (ctx as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  return undefined;
}
