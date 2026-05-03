/**
 * P11-001 — `lookup_invoices` voice skill.
 *
 * Lookups bypass the proposals pipeline. Read-only — no draft/approve.
 * Returns count + total + per-invoice number/amount/due for the
 * caller's invoices, defaulting to "open" status (open + partially_paid).
 */
import type { JobRepository } from '../../jobs/job';
import type {
  Invoice,
  InvoiceRepository,
  InvoiceStatus,
} from '../../invoices/invoice';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';

export interface LookupInvoicesInput {
  tenantId: string;
  customerId: string;
  /**
   * Optional explicit status filter. When omitted, defaults to "open"
   * — invoices the customer can still pay (`open` or
   * `partially_paid`). 'sent'/'overdue' are not InvoiceStatus values
   * in this codebase so we map the dispatch-spec language to the
   * actual schema.
   */
  status?: InvoiceStatus | 'open_only';
  timezone?: string;
  sessionId?: string;
}

export interface LookupInvoicesItem {
  invoiceId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  amountCents: number;
  amountDueCents: number;
  dueDate?: Date;
}

export type LookupInvoicesResult =
  | {
      status: 'found';
      summary: string;
      data: { count: number; totalCents: number; invoices: LookupInvoicesItem[] };
    }
  | { status: 'none'; summary: string; data: { count: 0; totalCents: 0; invoices: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupInvoicesDeps {
  jobRepo: JobRepository;
  invoiceRepo: InvoiceRepository;
  lookupEvents?: LookupEventService;
}

/** Minimal money formatter — `$120.50` reads correctly on both TTS engines. */
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

const OPEN_STATUSES: InvoiceStatus[] = ['open', 'partially_paid'];

function isOpen(inv: Invoice): boolean {
  return OPEN_STATUSES.includes(inv.status);
}

export async function lookupInvoices(
  input: LookupInvoicesInput,
  deps: LookupInvoicesDeps,
): Promise<LookupInvoicesResult> {
  const start = Date.now();
  const recordEvent = async (
    payload: Omit<RecordLookupEventInput, 'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'>,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_invoices',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow audit-write errors */
    }
  };

  if (!deps.jobRepo.findByCustomer) {
    const message = "I'm having trouble pulling up your invoices right now.";
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
    const message = "I'm having trouble pulling up your invoices right now.";
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
  let invoices = invoiceLists.flat();
  if (!input.status || input.status === 'open_only') {
    invoices = invoices.filter(isOpen);
  } else {
    invoices = invoices.filter((i) => i.status === input.status);
  }

  invoices.sort((a, b) => {
    const ad = a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bd = b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ad - bd;
  });

  const items: LookupInvoicesItem[] = invoices.map((i) => ({
    invoiceId: i.id,
    invoiceNumber: i.invoiceNumber,
    status: i.status,
    amountCents: i.totals.totalCents,
    amountDueCents: i.amountDueCents,
    dueDate: i.dueDate,
  }));

  if (items.length === 0) {
    const message =
      input.status && input.status !== 'open_only'
        ? `I'm not seeing any ${input.status.replace('_', ' ')} invoices on your account.`
        : "You don't have any open invoices right now.";
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary: message });
    return {
      status: 'none',
      summary: message,
      data: { count: 0, totalCents: 0, invoices: [] },
    };
  }

  const totalCents = items.reduce((sum, i) => sum + i.amountDueCents, 0);
  const head = items[0];
  const dueText = formatDueDate(head.dueDate, input.timezone);
  let summary: string;
  if (items.length === 1) {
    summary =
      `You have one open invoice — ${head.invoiceNumber} for ${formatCents(head.amountDueCents)}` +
      (dueText ? `, due ${dueText}.` : '.');
  } else {
    summary =
      `You have ${items.length} open invoices totaling ${formatCents(totalCents)}. ` +
      `The earliest is ${head.invoiceNumber} for ${formatCents(head.amountDueCents)}` +
      (dueText ? `, due ${dueText}.` : '.');
  }

  await recordEvent({
    resultStatus: 'found',
    resultCount: items.length,
    summary,
  });

  return {
    status: 'found',
    summary,
    data: { count: items.length, totalCents, invoices: items },
  };
}
