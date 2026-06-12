/**
 * P5-020 — Hourly digest delivery sweep.
 */
import type { Logger } from '../logging/logger';
import type { SettingsRepository } from '../settings/settings';
import type { ProposalRepository } from '../proposals/proposal';
import { buildDigestSections, renderDigestSms } from './generator';
import type { DigestEntryRepository } from './repository';

const DIGEST_HOUR_START = 18;
const DIGEST_HOUR_END = 21;

export interface DigestWorkerDeps {
  settingsRepo: SettingsRepository;
  proposalRepo: ProposalRepository;
  digestRepo: DigestEntryRepository;
  listTenantIds: () => Promise<string[]>;
  sendSms?: (to: string, body: string) => Promise<void>;
  resolveOwnerPhone: (tenantId: string) => Promise<string | null>;
  logger: Logger;
  now?: () => Date;
}

function tenantLocalHour(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  return hour ? Number(hour) : now.getUTCHours();
}

function tenantLocalDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export async function runDigestSweep(deps: DigestWorkerDeps): Promise<{ sent: number }> {
  const now = deps.now ?? (() => new Date());
  const tenantIds = await deps.listTenantIds();
  let sent = 0;

  for (const tenantId of tenantIds) {
    try {
      const settings = await deps.settingsRepo.findByTenant(tenantId);
      const tz = settings?.timezone ?? 'America/New_York';
      const hour = tenantLocalHour(now(), tz);
      if (hour < DIGEST_HOUR_START || hour > DIGEST_HOUR_END) continue;

      const localDate = tenantLocalDate(now(), tz);
      const existing = await deps.digestRepo.findByTenantDate(tenantId, localDate);
      if (existing?.deliveryStatus === 'sent' || existing?.deliveryStatus === 'acked') {
        continue;
      }

      const [ready, drafts] = await Promise.all([
        deps.proposalRepo.findByStatus(tenantId, 'ready_for_review'),
        deps.proposalRepo.findByStatus(tenantId, 'draft'),
      ]);
      const markerProposals = [...ready, ...drafts].filter((p) => {
        const created = p.createdAt.toISOString().slice(0, 10);
        return created === localDate;
      });

      const sections = buildDigestSections({
        businessName: settings?.businessName ?? 'Your shop',
        localDate,
        stats: {
          jobsCompleted: 0,
          invoicedCents: 0,
          collectedCents: 0,
          quotesSent: 0,
          quotesValueCents: 0,
          followUpsSent: 0,
          tomorrowAppointmentCount: 0,
        },
        markerProposals,
        lessons: [],
      });
      const body = renderDigestSms(sections, settings?.businessName ?? 'Your shop');
      const entry = await deps.digestRepo.upsertPending(tenantId, localDate, body, sections);

      const phone = await deps.resolveOwnerPhone(tenantId);
      if (deps.sendSms && phone) {
        await deps.sendSms(phone, body);
        await deps.digestRepo.markSent(tenantId, entry.id);
        sent += 1;
      }
    } catch (err) {
      deps.logger.error('digest sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { sent };
}
