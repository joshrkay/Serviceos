/**
 * P11-001 — `lookup_balance` voice skill.
 *
 * Sums every unpaid invoice the customer has and returns
 * `{ balanceCents, openCount, oldestDueDate }` plus a TTS summary.
 *
 * Lookups bypass the proposals pipeline. Read-only.
 */
import type { JobRepository } from '../../jobs/job';
import type { InvoiceRepository } from '../../invoices/invoice';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';

export interface LookupBalanceInput {
  tenantId: string;
  customerId: string;
  timezone?: string;
  sessionId?: string;
}

export type LookupBalanceResult =
  | {
      status: 'found';
      summary: string;
      data: { balanceCents: number; openCount: number; oldestDueDate?: Date };
    }
  | {
      status: 'none';
      summary: string;
      data: { balanceCents: 0; openCount: 0; oldestDueDate?: undefined };
    }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupBalanceDeps {
  jobRepo: JobRepository;
  invoiceRepo: InvoiceRepository;
  lookupEvents?: LookupEventService;
}

function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

function formatDueDate(d: Date | undefined, timezone?: string): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(d);
}

export async function lookupBalance(
  input: LookupBalanceInput,
  deps: LookupBalanceDeps,
): Promise<LookupBalanceResult> {
  const start = Date.now();
  const recordEvent = async (
    payload: Omit<RecordLookupEventInput, 'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'>,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_balance',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow */
    }
  };

  if (!deps.jobRepo.findByCustomer) {
    const message = "I'm having trouble checking your balance right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: 'JobRepository.findByCustomer is required' },
    };
  }

  let jobs;
  try {
    jobs = await deps.jobRepo.findByCustomer(input.tenantId, input.customerId, {
      includeArchived: true,
    });
  } catch (err) {
    const message = "I'm having trouble checking your balance right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  const invoiceLists = await Promise.all(
    jobs.map((j) => deps.invoiceRepo.findByJob(input.tenantId, j.id)),
  );
  const invoices = invoiceLists.flat().filter((i) => i.amountDueCents > 0);

  if (invoices.length === 0) {
    const message = 'Your account is paid in full — nothing currently owed.';
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary: message });
    return {
      status: 'none',
      summary: message,
      data: { balanceCents: 0, openCount: 0 },
    };
  }

  const balanceCents = invoices.reduce((sum, i) => sum + i.amountDueCents, 0);
  const withDue = invoices.filter((i) => i.dueDate);
  const oldestDueDate = withDue.length
    ? withDue.reduce((oldest, i) => (i.dueDate! < oldest ? i.dueDate! : oldest), withDue[0].dueDate!)
    : undefined;

  const dueText = formatDueDate(oldestDueDate, input.timezone);
  const summary =
    invoices.length === 1
      ? `Your current balance is ${formatCents(balanceCents)}` +
        (dueText ? `, due ${dueText}.` : '.')
      : `Your current balance is ${formatCents(balanceCents)} across ${invoices.length} open invoices` +
        (dueText ? `, with the earliest due ${dueText}.` : '.');

  await recordEvent({
    resultStatus: 'found',
    resultCount: invoices.length,
    summary,
  });

  return {
    status: 'found',
    summary,
    data: {
      balanceCents,
      openCount: invoices.length,
      ...(oldestDueDate ? { oldestDueDate } : {}),
    },
  };
}
