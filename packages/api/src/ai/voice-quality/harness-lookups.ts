/**
 * #1395 — the voice-quality harnesses' `lookups` bundle (the #869 shape).
 *
 * Both harness lanes build a voice-turn processor that serves phone lookups
 * through the SAME shared dispatch production uses
 * (`answerPhoneLookup` → `workers/voice-lookup-answer`). Layer 1 (text mode,
 * Gather-shaped) and Layer 2 (media-streams `speechTurn`) must hand it the
 * same bundle, or the two lanes answer lookups differently. Built from the
 * runner's seeded `RepoBundle`; the extras the bundle needs and the bundle
 * does not own (agreements, catalog, settings, a pinned clock) are optional
 * so a lane without script fixtures for them wires it in one line.
 *
 * Nothing here is a lookup switch.
 */
import { InMemoryAgreementRepository, type AgreementRepository } from '../../agreements/agreement';
import { InMemoryCatalogItemRepository, type CatalogItemRepository } from '../../catalog/catalog-item';
import { InMemoryMoneyDashboardRepository } from '../../reports/money-dashboard';
import type { SettingsRepository } from '../../settings/settings';
import type { PhoneLookupDeps } from '../voice-turn/phone-lookup-surface';
import type { RepoBundle } from './runner';
import { vqResolveMemberRole } from './text-mode-driver';

export interface HarnessLookupExtras {
  /** Shared with the caller-plan resolver when the lane wires one (#897). */
  agreementRepo?: AgreementRepository;
  catalogRepo?: CatalogItemRepository;
  settingsRepo?: SettingsRepository;
  now?: () => Date;
}

export function buildHarnessPhoneLookups(
  repos: RepoBundle,
  extras: HarnessLookupExtras = {},
): PhoneLookupDeps {
  const { settingsRepo, now } = extras;
  return {
    answers: {
      invoiceRepo: repos.invoiceRepo,
      estimateRepo: repos.estimateRepo,
      leadRepo: repos.leadRepo,
      agreementRepo: extras.agreementRepo ?? new InMemoryAgreementRepository(),
      moneyDashboardRepo: new InMemoryMoneyDashboardRepository(),
      catalogRepo: extras.catalogRepo ?? new InMemoryCatalogItemRepository(),
      ...(settingsRepo ? { settingsRepo } : {}),
      // Harness-owned actor → role seam: the owner-line flag is the corpus's
      // identity vocabulary; no `users` fixtures exist.
      resolveMemberRole: vqResolveMemberRole,
    },
    shared: {
      jobRepo: repos.jobRepo,
      appointmentRepo: repos.appointmentRepo,
      customerRepo: repos.customerRepo,
      proposalRepo: repos.proposalRepo,
      // No `availabilityFinder`: with an appointmentRepo wired the shared
      // dispatch takes the business-hours-aware `lookupBookableAvailability`
      // path (F2), exactly as the live phone does.
    },
    // Spoken dates render in the tenant zone, as on the phone. Failure-soft.
    ...(settingsRepo
      ? {
          tenantTimezoneResolver: async (t: string) =>
            (await settingsRepo.findByTenant(t))?.timezone,
        }
      : {}),
    ...(now ? { now } : {}),
  };
}
