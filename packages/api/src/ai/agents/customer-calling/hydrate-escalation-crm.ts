/**
 * Fills EscalationContext CRM slots (tags, lastService, membership, notes)
 * before buildEscalationSummary runs. Pure orchestration over injected repos —
 * best-effort: any lookup failure returns partial enrichment, never throws.
 */
import type { CustomerRepository } from '../../../customers/customer';
import { normalizePhone } from '../../../customers/dedup';
import type { TagRepository } from '../../../customers/tag';
import type { JobRepository } from '../../../jobs/job';
import type { Job } from '../../../jobs/job';
import { POST_COMPLETION_STATUSES } from '../../../jobs/job-lifecycle';
import type { AgreementRepository } from '../../../agreements/agreement';
import type { Agreement } from '../../../agreements/agreement';
import type { EscalationContext } from './escalation-summary-builder';
import { createLogger } from '../../../logging/logger';

const logger = createLogger({
  service: 'ai.agents.customer-calling.hydrate-escalation-crm',
  environment: process.env.NODE_ENV || 'development',
});

export interface EscalationCrmRepos {
  customerRepo?: CustomerRepository;
  tagRepo?: TagRepository;
  jobRepo?: JobRepository;
  agreementRepo?: AgreementRepository;
}

export interface EscalationCrmIdentity {
  customerId?: string;
  phone?: string;
}

export interface HydratedEscalationCrm {
  /** Tags to merge onto EscalationContext.caller.tags */
  tags: ReadonlyArray<string>;
  /** CRM block for EscalationContext.customer */
  customer?: EscalationContext['customer'];
}

function isEffectiveMembership(a: Agreement, asOf: Date): boolean {
  if (a.status !== 'active') return false;
  const ymd = asOf.toISOString().slice(0, 10);
  if (a.startsOn > ymd) return false;
  if (a.endsOn && a.endsOn < ymd) return false;
  return true;
}

function pickMembership(
  agreements: ReadonlyArray<Agreement>,
  asOf: Date,
): { isMember: true; memberTier?: string } | undefined {
  const effective = agreements.filter((a) => isEffectiveMembership(a, asOf));
  if (effective.length === 0) return undefined;
  let best = effective[0];
  for (const a of effective) {
    if ((a.memberDiscountBps ?? 0) > (best.memberDiscountBps ?? 0)) best = a;
  }
  const tier = best.name?.trim();
  return tier ? { isMember: true, memberTier: tier } : { isMember: true };
}

function completionTime(job: Job): number {
  return (job.completedAt ?? job.updatedAt ?? job.createdAt).getTime();
}

function pickLastService(
  jobs: ReadonlyArray<Job>,
): NonNullable<EscalationContext['customer']>['lastService'] {
  const completed = jobs
    .filter((j) => (POST_COMPLETION_STATUSES as readonly string[]).includes(j.status))
    .slice()
    .sort((a, b) => completionTime(b) - completionTime(a));
  const latest = completed[0];
  if (!latest) return undefined;
  return {
    date: latest.completedAt ?? latest.updatedAt ?? latest.createdAt,
    type: latest.summary,
  };
}

async function resolveCustomerId(
  tenantId: string,
  identity: EscalationCrmIdentity,
  customerRepo: CustomerRepository,
): Promise<string | undefined> {
  if (identity.customerId) return identity.customerId;
  const phone = identity.phone?.trim();
  if (!phone || !customerRepo.findByPhoneNormalized) return undefined;
  const normalized = normalizePhone(phone);
  if (normalized.length < 7) return undefined;
  const matches = await customerRepo.findByPhoneNormalized(tenantId, normalized);
  return matches[0]?.id;
}

/**
 * Load CRM enrichment for an escalation. Returns empty tags / no customer
 * block when repos are unwired or the caller is unknown.
 */
export async function hydrateEscalationCrm(
  tenantId: string,
  identity: EscalationCrmIdentity,
  deps: EscalationCrmRepos,
): Promise<HydratedEscalationCrm> {
  if (!deps.customerRepo) return { tags: [] };

  try {
    const customerId = await resolveCustomerId(tenantId, identity, deps.customerRepo);
    if (!customerId) return { tags: [] };

    const customer = await deps.customerRepo.findById(tenantId, customerId);
    if (!customer) return { tags: [] };

    const tags: string[] = [];
    if (deps.tagRepo) {
      try {
        const listed = await deps.tagRepo.listForCustomer(tenantId, customerId);
        tags.push(...listed);
      } catch (err) {
        logger.warn('hydrateEscalationCrm: tag lookup failed', {
          tenantId,
          customerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (customer.preferredLanguage) {
      const lang = customer.preferredLanguage.trim().toLowerCase();
      if (lang && !tags.some((t) => t.toLowerCase() === lang || t.toLowerCase() === `lang:${lang}`)) {
        tags.push(lang === 'es' ? 'Spanish' : lang === 'en' ? 'English' : lang);
      }
    }

    let lastService: NonNullable<EscalationContext['customer']>['lastService'];
    if (deps.jobRepo?.findByCustomer) {
      try {
        const jobs = await deps.jobRepo.findByCustomer(tenantId, customerId, {
          includeArchived: true,
          limit: 25,
        });
        lastService = pickLastService(jobs);
      } catch (err) {
        logger.warn('hydrateEscalationCrm: job lookup failed', {
          tenantId,
          customerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let membership: { isMember: true; memberTier?: string } | undefined;
    if (deps.agreementRepo) {
      try {
        const agreements = await deps.agreementRepo.findByTenant(tenantId, {
          customerId,
          status: 'active',
        });
        membership = pickMembership(agreements, new Date());
      } catch (err) {
        logger.warn('hydrateEscalationCrm: agreement lookup failed', {
          tenantId,
          customerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const notes = customer.communicationNotes?.trim();
    const customerBlock: NonNullable<EscalationContext['customer']> = {
      ...(lastService ? { lastService } : {}),
      ...(membership ?? {}),
      ...(notes ? { communicationNotes: notes } : {}),
    };

    if (
      !customerBlock.lastService &&
      !customerBlock.isMember &&
      !customerBlock.communicationNotes
    ) {
      return { tags };
    }

    return { tags, customer: customerBlock };
  } catch (err) {
    logger.warn('hydrateEscalationCrm failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { tags: [] };
  }
}

/**
 * Merge session-derived caller context with CRM hydration.
 * Session fields win for name/phone/customerId/intent; CRM fills tags + customer.
 */
export function mergeCallerContextWithCrm<
  T extends {
    caller: EscalationContext['caller'];
    customer?: EscalationContext['customer'];
    intent: EscalationContext['intent'];
    transcriptSnapshot: EscalationContext['transcriptSnapshot'];
  },
>(base: T, crm: HydratedEscalationCrm): T {
  const mergedTags = [
    ...(base.caller.tags ?? []),
    ...crm.tags.filter((t) => !(base.caller.tags ?? []).includes(t)),
  ];
  const customer: EscalationContext['customer'] = {
    lastService: base.customer?.lastService ?? crm.customer?.lastService,
    isMember: base.customer?.isMember ?? crm.customer?.isMember,
    memberTier: base.customer?.memberTier ?? crm.customer?.memberTier,
    communicationNotes:
      base.customer?.communicationNotes ?? crm.customer?.communicationNotes,
  };
  const hasCustomer =
    customer.lastService != null ||
    customer.isMember === true ||
    Boolean(customer.communicationNotes);

  return {
    ...base,
    caller: {
      ...base.caller,
      ...(mergedTags.length > 0 ? { tags: mergedTags } : {}),
    },
    ...(hasCustomer ? { customer } : {}),
  };
}
