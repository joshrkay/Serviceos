/**
 * VQ-006 — `lookup_customer` voice skill.
 *
 * Read-only — bypasses the proposals pipeline (mirrors the rest of the
 * `lookup_*` family). Used when the caller wants to confirm or recite
 * the contact info on file, or when downstream code needs to resolve a
 * caller's identity (phone / email / name) into a customer record.
 *
 * Multiple matches are returned as an array — for example two
 * customers sharing a household phone — so the caller can be asked
 * which person is on the line.
 *
 * Phone numbers are masked (only the last 4 digits readable) before
 * being returned to the TTS layer to avoid leaking raw PII into
 * speech / logs / cassettes.
 */
import type { CustomerRepository, Customer } from '../../customers/customer';
import { maskPhone } from '../../telephony/twilio-call-control';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';

export type LookupCustomerIdentifier =
  | { type: 'id'; value: string }
  | { type: 'phone'; value: string }
  | { type: 'email'; value: string }
  | { type: 'name'; value: string };

export interface LookupCustomerInput {
  tenantId: string;
  identifier: LookupCustomerIdentifier;
  sessionId?: string;
  /** Max customers returned. Default 5. */
  limit?: number;
}

export interface LookupCustomerItem {
  customerId: string;
  displayName: string;
  /** Last-4 only — full phone never leaves the repo. */
  primaryPhoneMasked?: string;
  email?: string;
  communicationNotes?: string;
}

export type LookupCustomerResult =
  | {
      status: 'found';
      summary: string;
      data: { customers: LookupCustomerItem[] };
    }
  | {
      status: 'none';
      summary: string;
      data: { customers: [] };
    }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupCustomerDeps {
  customerRepo: CustomerRepository;
  lookupEvents?: LookupEventService;
}

function toItem(c: Customer): LookupCustomerItem {
  const item: LookupCustomerItem = {
    customerId: c.id,
    displayName: c.displayName,
  };
  if (c.primaryPhone) item.primaryPhoneMasked = maskPhone(c.primaryPhone);
  if (c.email) item.email = c.email;
  if (c.communicationNotes) item.communicationNotes = c.communicationNotes;
  return item;
}

export async function lookupCustomer(
  input: LookupCustomerInput,
  deps: LookupCustomerDeps,
): Promise<LookupCustomerResult> {
  const start = Date.now();
  const limit = input.limit ?? 5;

  const recordEvent = async (
    payload: Omit<
      RecordLookupEventInput,
      'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'
    >,
    customerId?: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        ...(customerId ? { customerId } : {}),
        intent: 'lookup_customer',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow — audit-write must never fail the call */
    }
  };

  let matches: Customer[];
  try {
    switch (input.identifier.type) {
      case 'id': {
        const c = await deps.customerRepo.findById(
          input.tenantId,
          input.identifier.value,
        );
        matches = c ? [c] : [];
        break;
      }
      case 'phone': {
        // Voice callers may say "555-234-5678" while the record was
        // saved as "+1 (555) 234-5678" — the dedup-style exact-prefix
        // compare misses these. We match on the last 10 digits (the
        // North American national number) which is permissive enough
        // for caller-ID resolution but still tenant-scoped.
        const target = input.identifier.value.replace(/\D/g, '');
        if (target.length < 7) {
          matches = [];
          break;
        }
        const tail = target.slice(-10);
        const all = await deps.customerRepo.findByTenant(input.tenantId, {
          includeArchived: true,
        });
        matches = all.filter((c) => {
          if (!c.primaryPhone) return false;
          const digits = c.primaryPhone.replace(/\D/g, '');
          return digits.endsWith(tail) || tail.endsWith(digits);
        });
        break;
      }
      case 'email': {
        if (!deps.customerRepo.findDuplicates) {
          matches = await deps.customerRepo.search(
            input.tenantId,
            input.identifier.value,
          );
          matches = matches.filter(
            (c) => c.email?.toLowerCase() === input.identifier.value.toLowerCase(),
          );
        } else {
          matches = await deps.customerRepo.findDuplicates(input.tenantId, {
            email: input.identifier.value,
          });
        }
        break;
      }
      case 'name': {
        matches = await deps.customerRepo.search(
          input.tenantId,
          input.identifier.value,
        );
        break;
      }
      default: {
        matches = [];
      }
    }
  } catch (err) {
    const message =
      "I'm having trouble pulling up your account right now. Let me get someone to help.";
    await recordEvent({
      resultStatus: 'error',
      resultCount: 0,
      summary: message,
    });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (matches.length === 0) {
    const summary =
      "I'm not seeing an account that matches. Want me to take down your details so we can set one up?";
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary });
    return { status: 'none', summary, data: { customers: [] } };
  }

  const sliced = matches.slice(0, limit);
  const items = sliced.map(toItem);

  let summary: string;
  if (items.length === 1) {
    const head = items[0];
    const phoneText = head.primaryPhoneMasked
      ? ` ending in ${head.primaryPhoneMasked.slice(-4)}`
      : '';
    summary = `I have ${head.displayName}${phoneText} on file.`;
  } else {
    summary =
      `I found ${items.length} accounts that match — ${items
        .map((i) => i.displayName)
        .join(', ')}. Which one is this?`;
  }

  await recordEvent(
    {
      resultStatus: 'found',
      resultCount: items.length,
      summary,
    },
    items.length === 1 ? items[0].customerId : undefined,
  );

  return { status: 'found', summary, data: { customers: items } };
}
