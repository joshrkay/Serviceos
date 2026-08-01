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
import {
  formatStructuredAddress,
  parseCompleteSpokenAddress,
  resolveSpokenAddress,
  type RequiredLocationField,
} from '@ai-service-os/shared';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  CustomerRepository,
  PreferredChannel,
  createCustomer,
} from '../../customers/customer';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { LocationRepository, createLocation } from '../../locations/location';
import { NoteRepository, createNote } from '../../notes/note';

/**
 * Parse the free-text address the caller spoke into the structured shape
 * `service_locations` requires. Returns `undefined` unless ALL FOUR
 * NOT NULL columns (street1, city, state, postal_code) are recoverable —
 * the same completeness gate `add_service_location` and lead conversion
 * already enforce (`refineCompleteAddress` in leads/enums.ts).
 *
 * The rules themselves now live in `@ai-service-os/shared`
 * (contracts/spoken-address.ts) so the API, the assistant route and the web
 * review card cannot disagree about what "complete" means. This re-export
 * is kept because it is the name the existing tests and callers use.
 */
export const parseSpokenAddress = parseCompleteSpokenAddress;

/** Human-readable name for a still-empty required column, for the note copy. */
const MISSING_FIELD_WORD: Record<RequiredLocationField, string> = {
  street1: 'street',
  city: 'city',
  state: 'state',
  postalCode: 'ZIP',
};

/**
 * The one line that must appear somewhere durable whenever a spoken address
 * could NOT become a `service_location`. Deliberately quotes the technician's
 * words verbatim and names what is still owed, so a human reading the customer
 * record later can finish the job without replaying the call.
 */
export function unstructuredAddressNote(
  verbatim: string,
  missing: readonly RequiredLocationField[],
): string {
  const needs = missing.map((f) => MISSING_FIELD_WORD[f]).join(', ');
  return (
    `Address from voice: "${verbatim}". ` +
    `Saved as a note, not a service location` +
    (needs ? ` — still needs ${needs}.` : '.')
  );
}

/** Join the operator's own notes with the address line, never clobbering either. */
function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join('\n\n') : undefined;
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
    // Optional: when wired, a COMPLETE address on the payload (spoken, or
    // completed by the approver on the review card) is promoted to a primary
    // service_location linked to the new customer. `customers` has no address
    // column — a linked location is the only STRUCTURED place an address can
    // live.
    private readonly locationRepo?: LocationRepository,
    // Optional: the never-lose-it net. An address that can't become a
    // service_location is written here as a pinned customer note. See
    // `preserveAddress` below for why this is the chosen destination.
    private readonly noteRepo?: NoteRepository,
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

    // ── Address routing, decided BEFORE the customer INSERT ───────────────
    //
    // The bug this exists for: an address rendered on the approval card, the
    // approver said yes, and it vanished — `service_locations` requires
    // street1/city/state/postal_code NOT NULL, spoken addresses on a job site
    // are usually street-only, so the handler correctly declined to invent
    // data and created nothing. Nothing else on `customers` held an address,
    // so the words were gone with no trace.
    //
    // `resolveSpokenAddress` (shared with the review card, so "complete" means
    // the same thing on both sides) merges the approver's structured fields
    // over anything parseable from the verbatim text and reports one of:
    //   'none'     → nothing to do
    //   'location' → all four NOT NULL columns satisfied
    //   'note'     → an address exists but is incomplete
    //
    // The decision is made HERE, before `createCustomer`, so the fallback can
    // ride along in the customer's own INSERT. That is what makes it a real
    // guarantee rather than a best-effort follow-up write: there is no window
    // in which the customer exists and the address does not.
    const addressPlan = resolveSpokenAddress(payload);
    const willWriteLocation = addressPlan.kind === 'location' && Boolean(this.locationRepo);
    const addressToPreserve =
      addressPlan.kind === 'none' || willWriteLocation
        ? undefined
        : addressPlan.verbatim || formatStructuredAddress(addressPlan.prefill) || undefined;
    const preservedLine = addressToPreserve
      ? unstructuredAddressNote(addressToPreserve, addressPlan.missing)
      : undefined;

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
          // The never-lose-it guarantee, part 1: when the address can't become
          // a service_location it is written into the customer row itself, in
          // the same INSERT. `communication_notes` is the ONLY free-text column
          // `customers` has (db/schema.ts migration 013) and it is already
          // rendered on CustomerDetail, so the words are on screen next to the
          // customer rather than buried in an audit table.
          ...(joinNotes(notes, preservedLine)
            ? { communicationNotes: joinNotes(notes, preservedLine)! }
            : {}),
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

    // A complete address becomes the customer's PRIMARY service_location.
    // Best-effort by design (same posture as the audit join-row below): a
    // location-write failure must never unwind a customer the approver
    // already said yes to — but it must not lose the address either, so the
    // catch falls through to the same preservation path an incomplete
    // address takes.
    let locationWritten = false;
    if (willWriteLocation) {
      try {
        await createLocation(
          {
            tenantId: context.tenantId,
            customerId: createdCustomerId,
            ...addressPlan.location!,
            isPrimary: true,
          },
          this.locationRepo!,
          this.auditRepo,
          context.executedBy,
          'voice_agent',
        );
        locationWritten = true;
      } catch {
        // Swallowed on purpose — see comment above. Preserved below instead.
      }
    }

    // The never-lose-it guarantee, part 2: the VISIBLE surface.
    //
    // Why a `notes` row and not something else. `customers` has no address
    // column, and the only other candidates were: the audit trail (durable but
    // an investigator's tool, not something an owner opening a customer would
    // ever see) and `communication_notes` alone (a single unattributed,
    // undated blob that the next edit of that field silently overwrites). A
    // `notes` row (db/schema.ts migration 037, entity_type 'customer') is
    // tenant-scoped under RLS, carries an author + timestamp, renders in the
    // customer's notes UI, and is already aggregated into the unified customer
    // timeline as a first-class `note` event (customers/timeline.ts). Pinned,
    // so it sorts to the top of the notes list where the gap is obvious.
    //
    // Belt AND braces on purpose: part 1 (communication_notes, written
    // atomically with the customer) is the guarantee that survives a missing
    // or failing note repo; this row is the surface a human actually reads.
    const needsPreservation =
      (addressToPreserve !== undefined && !locationWritten) ||
      // The location write failed after we'd decided not to preserve. The
      // address exists and is now nowhere — preserve it after the fact.
      (willWriteLocation && !locationWritten);
    if (needsPreservation) {
      const text =
        addressToPreserve ??
        addressPlan.verbatim ??
        formatStructuredAddress(addressPlan.prefill);
      await this.preserveAddress(createdCustomerId, text, addressPlan.missing, proposal, context);
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

  /**
   * Write the address somewhere a human will find it, and leave a queryable
   * audit marker that it happened. Three layers, each covering the previous
   * one's failure mode:
   *
   *   1. a PINNED `notes` row on the customer — the surface an owner reads;
   *   2. `communication_notes` on the customer row — the backstop when no
   *      NoteRepository is wired or the note write throws. (On the ordinary
   *      incomplete-address path this was already written atomically with the
   *      customer; this re-write matters for the location-write-failed path,
   *      where part 1 was skipped because we expected the location to land.)
   *   3. a `customer.address_unstructured` audit event — so "how often does
   *      this happen, and to whom" is one query, not a table scan of notes.
   *
   * Every layer is individually failure-soft: the approver already said yes to
   * this customer and nothing here may unwind it.
   */
  private async preserveAddress(
    customerId: string,
    verbatim: string,
    missing: readonly RequiredLocationField[],
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<void> {
    const content = unstructuredAddressNote(verbatim, missing);

    let noteWritten = false;
    if (this.noteRepo) {
      try {
        await createNote(
          {
            tenantId: context.tenantId,
            entityType: 'customer',
            entityId: customerId,
            content,
            authorId: context.executedBy,
            authorRole: 'voice_agent',
            isPinned: true,
          },
          this.noteRepo,
          this.auditRepo,
        );
        noteWritten = true;
      } catch {
        // Fall through to the customer-row backstop below.
      }
    }

    if (!noteWritten && this.customerRepo) {
      try {
        const existing = await this.customerRepo.findById(context.tenantId, customerId);
        const merged = joinNotes(existing?.communicationNotes, content);
        if (merged && merged !== existing?.communicationNotes) {
          await this.customerRepo.update(context.tenantId, customerId, {
            communicationNotes: merged,
            updatedAt: new Date(),
          });
        }
      } catch {
        // Nothing further to try — the audit marker below is the last trace.
      }
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'customer.address_unstructured',
            entityType: 'customer',
            entityId: customerId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'create_customer',
              source: 'voice',
              address: verbatim,
              missingFields: [...missing],
              preservedAs: noteWritten ? 'note' : 'communication_notes',
            },
          }),
        );
      } catch {
        // Audit is the observability layer, not the guarantee.
      }
    }
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
