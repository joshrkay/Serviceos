/**
 * P11-001 — `lookup_agreements` voice skill.
 *
 * Read-only lookup of the customer's active service agreements,
 * surfacing the next scheduled run for each. Bypasses proposals.
 */
import type { Agreement, AgreementRepository } from '../../agreements/agreement';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';
import { t, type Language } from '../i18n/i18n';

export interface LookupAgreementsInput {
  tenantId: string;
  customerId: string;
  timezone?: string;
  sessionId?: string;
  /** P11-002: spoken-summary language. Defaults to 'en'. */
  language?: Language;
}

export interface LookupAgreementsItem {
  agreementId: string;
  name: string;
  nextRunAt: Date;
  priceCents: number;
}

export type LookupAgreementsResult =
  | {
      status: 'found';
      summary: string;
      data: { agreements: LookupAgreementsItem[] };
    }
  | { status: 'none'; summary: string; data: { agreements: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupAgreementsDeps {
  agreementRepo: AgreementRepository;
  lookupEvents?: LookupEventService;
}

function formatNextRun(d: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(d);
}

export async function lookupAgreements(
  input: LookupAgreementsInput,
  deps: LookupAgreementsDeps,
): Promise<LookupAgreementsResult> {
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
        intent: 'lookup_agreements',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow */
    }
  };

  let rows: Agreement[];
  try {
    rows = await deps.agreementRepo.findByTenant(input.tenantId, {
      customerId: input.customerId,
      status: 'active',
    });
  } catch (err) {
    const message = t('lookup.agreements.error', lang);
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (rows.length === 0) {
    const message = t('lookup.agreements.none', lang);
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary: message });
    return { status: 'none', summary: message, data: { agreements: [] } };
  }

  const items: LookupAgreementsItem[] = rows
    .map((a) => ({
      agreementId: a.id,
      name: a.name,
      nextRunAt: a.nextRunAt,
      priceCents: a.priceCents,
    }))
    .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime());

  const head = items[0];
  const headWhen = formatNextRun(head.nextRunAt, input.timezone);
  const summary =
    items.length === 1
      ? `Your ${head.name} plan is next scheduled for ${headWhen}.`
      : `You have ${items.length} active service plans. The next one — ${head.name} — is scheduled for ${headWhen}.`;

  await recordEvent({
    resultStatus: 'found',
    resultCount: items.length,
    summary,
  });

  return { status: 'found', summary, data: { agreements: items } };
}
