/**
 * P11-001 — `lookup_account_summary` voice skill.
 *
 * Two-sentence digest of the customer's account state. Internally
 * fans out via Promise.all to the other lookup skills so we hit the
 * sub-5s end-to-end latency budget. Bypasses proposals.
 */
import { lookupAppointments } from './lookup-appointments';
import { lookupBalance } from './lookup-balance';
import { lookupAgreements } from './lookup-agreements';
import type { JobRepository } from '../../jobs/job';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { AgreementRepository } from '../../agreements/agreement';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';
import { t, type Language } from '../i18n/i18n';

export interface LookupAccountSummaryInput {
  tenantId: string;
  customerId: string;
  timezone?: string;
  sessionId?: string;
  /** P11-002: spoken-summary language. Defaults to 'en'. */
  language?: Language;
}

export interface LookupAccountSummaryDeps {
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  invoiceRepo: InvoiceRepository;
  agreementRepo: AgreementRepository;
  lookupEvents?: LookupEventService;
}

export type LookupAccountSummaryResult =
  | {
      status: 'found';
      summary: string;
      data: {
        nextAppointmentSummary: string;
        balanceSummary: string;
        agreementSummary: string;
      };
    }
  | {
      status: 'none';
      summary: string;
      data: {
        nextAppointmentSummary: string;
        balanceSummary: string;
        agreementSummary: string;
      };
    }
  | { status: 'error'; summary: string; data: { error: string } };

export async function lookupAccountSummary(
  input: LookupAccountSummaryInput,
  deps: LookupAccountSummaryDeps,
): Promise<LookupAccountSummaryResult> {
  const start = Date.now();
  const lang: Language = input.language ?? 'en';
  const recordEvent = async (
    payload: Omit<RecordLookupEventInput, 'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'>,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_account_summary',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow */
    }
  };

  // Fan-out fan-in for the latency budget. Each child skill is given a
  // bare-minimum dep set + NO `lookupEvents` — we only write a single
  // `lookup_account_summary` row for the parent invocation, not one
  // per sub-lookup (would double the audit volume).
  const [apptResult, balanceResult, agreementResult] = await Promise.all([
    lookupAppointments(
      {
        tenantId: input.tenantId,
        customerId: input.customerId,
        language: lang,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
      { jobRepo: deps.jobRepo, appointmentRepo: deps.appointmentRepo },
    ),
    lookupBalance(
      {
        tenantId: input.tenantId,
        customerId: input.customerId,
        language: lang,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
      { jobRepo: deps.jobRepo, invoiceRepo: deps.invoiceRepo },
    ),
    lookupAgreements(
      {
        tenantId: input.tenantId,
        customerId: input.customerId,
        language: lang,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
      { agreementRepo: deps.agreementRepo },
    ),
  ]);

  if (
    apptResult.status === 'error' ||
    balanceResult.status === 'error' ||
    agreementResult.status === 'error'
  ) {
    const message = t('lookup.account.error', lang);
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: {
        error: 'one or more sub-lookups failed',
      },
    };
  }

  // Build a two-sentence digest.
  const sentence1 = apptResult.summary;
  const sentence2 =
    balanceResult.status === 'found'
      ? balanceResult.summary
      : agreementResult.status === 'found'
        ? agreementResult.summary
        : balanceResult.summary;

  const summary = `${sentence1} ${sentence2}`;
  const anyFound =
    apptResult.status === 'found' ||
    balanceResult.status === 'found' ||
    agreementResult.status === 'found';

  await recordEvent({
    resultStatus: anyFound ? 'found' : 'none',
    resultCount:
      (apptResult.status === 'found' ? apptResult.data.appointments.length : 0) +
      (balanceResult.status === 'found' ? balanceResult.data.openCount : 0) +
      (agreementResult.status === 'found' ? agreementResult.data.agreements.length : 0),
    summary,
  });

  return {
    status: anyFound ? 'found' : 'none',
    summary,
    data: {
      nextAppointmentSummary: apptResult.summary,
      balanceSummary: balanceResult.summary,
      agreementSummary: agreementResult.summary,
    },
  };
}
