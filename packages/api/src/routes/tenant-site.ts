import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { SettingsRepository } from '../settings/settings';
import {
  TenantSite,
  TenantSiteRepository,
  TenantSiteSlugTakenError,
} from '../tenant-site/tenant-site';
import { SLUG_PROBLEM_MESSAGES, normalizeSlug, slugProblem, suggestSlug } from '../tenant-site/slug';
import {
  DOMAIN_PROBLEM_MESSAGES,
  checkCustomDomain,
  cnameTarget,
  customDomainErrorMessage,
  domainProblem,
  effectiveSiteUrl,
  normalizeDomain,
} from '../tenant-site/custom-domain';
import type { CertificateProvider, DnsResolver } from '../tenant-site/custom-domain';
import { renderTenantSitePage } from '../tenant-site/render';
import { loadTenantSiteView } from '../tenant-site/view';
import type { TenantSiteViewDeps } from '../tenant-site/view';
import { resolvePublicServiceTypes } from '../public-intake/public-business-info';
import { createProposal, ProposalRepository } from '../proposals/proposal';
import { rejectProposal } from '../proposals/actions';
import type { TenantSiteAboutTask } from '../ai/tasks/tenant-site-about-task';
import type { Role } from '../auth/rbac';
import type { TenantTransactionRunner } from '../db/tenant-transaction';

/**
 * D-044 / #1768 — the owner's hosted-site controls (Settings → Website).
 *
 *   GET  /api/tenant-site          — address, live state, the site URL
 *   GET  /api/tenant-site/check    — is this address usable?
 *   PUT  /api/tenant-site/address  — pick the address (while unpublished)
 *   GET  /api/tenant-site/preview  — the page as it would render, as HTML text
 *   POST /api/tenant-site/publish
 *   POST /api/tenant-site/unpublish
 *   PUT  /api/tenant-site/domain       — connect a domain the owner already owns (#1770)
 *   POST /api/tenant-site/domain/check — check the CNAME / HTTPS now, instead of waiting for the sweep
 *   DELETE /api/tenant-site/domain     — disconnect it
 *   GET  /api/tenant-site/about        — the approved about copy and any draft awaiting approval
 *   POST /api/tenant-site/about/draft  — AI drafts the about copy as an `update_tenant_site_about`
 *                                        proposal; approve / edit / reject use /api/proposals
 *
 * Owner-only (settings:update), like the Get found online checklist. Publish
 * and unpublish are audited, and they keep `websiteUrl` on tenant settings in
 * step: publishing fills it in when the owner has none, unpublishing clears it
 * only when it still points at the tenant site.
 */
export interface TenantSiteRouteDeps {
  /** Undefined when TENANT_SITE_BASE_DOMAIN is unset: the feature is off. */
  baseDomain: string | undefined;
  siteRepo: TenantSiteRepository;
  settingsRepo: Pick<SettingsRepository, 'findByTenant' | 'update'>;
  viewDeps: TenantSiteViewDeps;
  auditRepo: AuditRepository;
  /** The about-copy draft goes through the LLM gateway (ai/tasks/tenant-site-about-task.ts). */
  aboutTask: Pick<TenantSiteAboutTask, 'draft'>;
  proposalRepo: ProposalRepository;
  /**
   * The about-copy draft runs outside the request transaction
   * (LLM_LONG_CALL_ROUTES — it awaits the LLM call), so its writes after the
   * call (supersede the pending draft, create the new one, audit) commit
   * together in one run of this runner, or not at all. Must match the repos:
   * PgTenantTransactionRunner on the app pool, InMemoryTransactionRunner with
   * the in-memory repos.
   */
  transactionRunner: TenantTransactionRunner;
  /**
   * #1770 — what connecting a domain needs. Undefined when no certificate
   * provider is configured (D-046): the feature is then off.
   */
  domain?: { provider: CertificateProvider; dns: DnsResolver; reservedHosts: readonly string[] } | undefined;
  now?: () => Date;
}

const PENDING_STATUSES = ['draft', 'ready_for_review'] as const;

/**
 * Serializes a tenant's about-copy drafts once their LLM calls return. Without
 * it, two drafts that finish together read the same pending draft: one
 * supersedes it and the other's supersede then fails (409), or, with nothing
 * pending yet, neither sees the other and both stay pending, which breaks the
 * one-draft-awaiting-the-owner rule.
 */
const ABOUT_DRAFT_LOCK = 'tenant_site.about_draft';

const addressSchema = z.object({ slug: z.string().max(200) });

export function createTenantSiteRouter(deps: TenantSiteRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const guard = [requireAuth, requireTenant, requirePermission('settings:update')];

  const siteUrl = (slug: string): string => `https://${slug}.${deps.baseDomain}`;

  function requireEnabled(): string {
    if (!deps.baseDomain) {
      throw new ValidationError('Hosted websites are not available yet');
    }
    return deps.baseDomain;
  }

  function presentDomain(site: TenantSite) {
    const claim = site.customDomain;
    if (!claim) return null;
    return {
      domain: claim.domain,
      status: claim.status,
      verified: claim.status === 'verified',
      // The one record the owner adds at their registrar.
      record: { type: 'CNAME', host: claim.domain, value: cnameTarget(site.slug, deps.baseDomain ?? '') },
      error: claim.error ? { code: claim.error, message: customDomainErrorMessage(claim.error) } : null,
      checkedAt: claim.checkedAt ? claim.checkedAt.toISOString() : null,
      verifiedAt: claim.verifiedAt ? claim.verifiedAt.toISOString() : null,
      url: `https://${claim.domain}`,
    };
  }

  function present(site: TenantSite | null) {
    return site
      ? {
          slug: site.slug,
          published: site.published,
          publishedAt: site.publishedAt ? site.publishedAt.toISOString() : null,
          url: siteUrl(site.slug),
          domain: presentDomain(site),
        }
      : null;
  }

  function requireDomainEnabled() {
    const baseDomain = requireEnabled();
    if (!deps.domain) throw new ValidationError('Connecting your own domain is not available yet');
    return { baseDomain, domain: deps.domain };
  }

  /** Points `websiteUrl` back at `fallback` (or clears it) when it still names the connected domain. */
  async function releaseWebsiteFromDomain(tenantId: string, domain: string, fallback: string | null): Promise<boolean> {
    const settings = await deps.settingsRepo.findByTenant(tenantId);
    if (settings?.websiteUrl?.trim().toLowerCase() !== `https://${domain}`) return false;
    await deps.settingsRepo.update(tenantId, { websiteUrl: fallback });
    return true;
  }

  async function dropFromProvider(domain: string, ref: string | null): Promise<void> {
    if (!ref || !deps.domain) return;
    // Best effort: a slot left on the provider is cleaned up by hand, and must not block the owner.
    await deps.domain.provider.remove(domain, ref).catch(() => undefined);
  }

  async function checkSlug(
    tenantId: string,
    raw: string,
  ): Promise<{ slug: string; problem: keyof typeof SLUG_PROBLEM_MESSAGES | null }> {
    const slug = normalizeSlug(raw);
    const problem = slugProblem(slug) ?? ((await deps.siteRepo.isSlugTaken(slug, tenantId)) ? 'taken' : null);
    return { slug, problem };
  }

  async function audit(req: AuthenticatedRequest, eventType: string, metadata: Record<string, unknown>) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        eventType,
        entityType: 'tenant_site',
        entityId: req.auth!.tenantId,
        metadata,
      }),
    );
  }

  router.get(
    '/',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const [site, settings] = await Promise.all([
        deps.siteRepo.findByTenant(tenantId),
        deps.settingsRepo.findByTenant(tenantId),
      ]);
      res.json({
        data: {
          enabled: Boolean(deps.baseDomain),
          domainConnectEnabled: Boolean(deps.baseDomain && deps.domain),
          baseDomain: deps.baseDomain ?? null,
          site: present(site),
          suggestedSlug: suggestSlug(settings?.businessName ?? ''),
          websiteUrl: settings?.websiteUrl ?? null,
        },
      });
    }),
  );

  router.get(
    '/check',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      requireEnabled();
      const raw = typeof req.query.slug === 'string' ? req.query.slug : '';
      const { slug, problem } = await checkSlug(req.auth!.tenantId, raw);
      res.json({
        data: {
          slug,
          available: problem === null,
          ...(problem ? { problem, message: SLUG_PROBLEM_MESSAGES[problem] } : {}),
        },
      });
    }),
  );

  router.put(
    '/address',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      requireEnabled();
      const tenantId = req.auth!.tenantId;
      const { slug: raw } = addressSchema.parse(req.body);
      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (existing?.published && normalizeSlug(raw) !== existing.slug) {
        throw new ValidationError('Unpublish your site before changing its address');
      }
      const { slug, problem } = await checkSlug(tenantId, raw);
      if (problem === 'taken') throw new ConflictError(SLUG_PROBLEM_MESSAGES.taken, { problem });
      if (problem) throw new ValidationError(SLUG_PROBLEM_MESSAGES[problem], { problem });
      let site: TenantSite;
      try {
        site = await deps.siteRepo.setSlug(tenantId, slug);
      } catch (err) {
        if (err instanceof TenantSiteSlugTakenError) {
          throw new ConflictError(SLUG_PROBLEM_MESSAGES.taken, { problem: 'taken' });
        }
        throw err;
      }
      if (existing?.slug !== slug) {
        await audit(req, 'tenant_site.address_set', { slug, previousSlug: existing?.slug ?? null });
        // The CNAME names the address, so a new address means the domain must be pointed and verified again.
        if (existing?.customDomain) {
          await releaseWebsiteFromDomain(tenantId, existing.customDomain.domain, null);
          await dropFromProvider(existing.customDomain.domain, existing.customDomain.providerRef);
          site = (await deps.siteRepo.restartCustomDomain(tenantId, now())) ?? site;
        }
      }
      res.json({ data: present(site) });
    }),
  );

  router.get(
    '/preview',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const view = await loadTenantSiteView(deps.viewDeps, req.auth!.tenantId);
      if (!view) throw new ValidationError('Add your business name in Settings before previewing your site');
      res.json({ data: { html: renderTenantSitePage(view) } });
    }),
  );

  async function pendingAboutProposals(tenantId: string) {
    const lists = await Promise.all(PENDING_STATUSES.map((s) => deps.proposalRepo.findByStatus(tenantId, s)));
    return lists
      .flat()
      .filter((p) => p.proposalType === 'update_tenant_site_about')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  router.get(
    '/about',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const [settings, pending] = await Promise.all([
        deps.settingsRepo.findByTenant(tenantId),
        pendingAboutProposals(tenantId),
      ]);
      const latest = pending[0];
      res.json({
        data: {
          current: settings?.siteAboutText?.trim() || null,
          pending: latest
            ? {
                proposalId: latest.id,
                aboutText: typeof latest.payload.aboutText === 'string' ? latest.payload.aboutText : '',
              }
            : null,
        },
      });
    }),
  );

  router.post(
    '/about/draft',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const settings = await deps.settingsRepo.findByTenant(tenantId);
      if (!settings?.businessName?.trim()) {
        throw new ValidationError('Add your business name in Settings before drafting your about text');
      }
      const services = (await resolvePublicServiceTypes(settings, deps.viewDeps.packRegistry)).map(
        (s) => s.displayName,
      );

      // The model call goes through the LLM gateway (aboutTask); it only drafts.
      // No transaction is open across it: the route is an LLM_LONG_CALL_ROUTE,
      // and the reads above each ran in their own short one.
      const { aboutText } = await deps.aboutTask.draft({
        tenantId,
        businessName: settings.businessName.trim(),
        services,
        serviceArea: settings.serviceAreaText ?? null,
        brandVoice: settings.brandVoice ?? null,
      });

      // One short tenant transaction, opened only now: supersede, create and
      // audit commit together, so a failure part-way leaves the old draft
      // pending rather than superseded with nothing in its place.
      const proposal = await deps.transactionRunner.run(tenantId, async (scope) => {
        await scope.lock(ABOUT_DRAFT_LOCK);

        // One draft awaiting the owner at a time: a new draft replaces the old.
        for (const stale of await pendingAboutProposals(tenantId)) {
          await rejectProposal(
            deps.proposalRepo,
            tenantId,
            stale.id,
            req.auth!.userId,
            req.auth!.role as Role,
            'superseded',
            'Replaced by a new draft',
            undefined,
            deps.auditRepo,
          );
        }

        // No trust tier is passed: the proposal lands as a draft and only an
        // explicit owner approval can run it (manual action class).
        const created = createProposal({
          tenantId,
          proposalType: 'update_tenant_site_about',
          payload: { aboutText },
          summary: 'Add an "About us" section to your website',
          explanation: 'Drafted from your business name, services and service area. Edit it before approving if you like.',
          createdBy: req.auth!.userId,
          targetEntityType: 'tenant_site',
          targetEntityId: tenantId,
        });
        await deps.proposalRepo.create(created);
        await audit(req, 'tenant_site.about_drafted', { proposalId: created.id, length: aboutText.length });
        return created;
      });
      res.status(201).json({ data: { proposalId: proposal.id, aboutText } });
    }),
  );

  router.post(
    '/publish',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      requireEnabled();
      const tenantId = req.auth!.tenantId;
      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (!existing) throw new ValidationError('Pick an address for your site first');
      if (await deps.siteRepo.isSlugTaken(existing.slug, tenantId)) {
        throw new ConflictError(SLUG_PROBLEM_MESSAGES.taken, { problem: 'taken' });
      }
      const view = await loadTenantSiteView(deps.viewDeps, tenantId);
      if (!view) throw new ValidationError('Add your business name in Settings before publishing your site');

      const at = now();
      const site = await deps.siteRepo.setPublished(tenantId, true, at);
      if (!site) throw new NotFoundError('Tenant site', tenantId);

      const settings = await deps.settingsRepo.findByTenant(tenantId);
      const filledWebsite = !settings?.websiteUrl?.trim();
      if (filledWebsite) {
        await deps.settingsRepo.update(tenantId, { websiteUrl: effectiveSiteUrl(site, deps.baseDomain!) });
      }
      await audit(req, 'tenant_site.published', {
        slug: site.slug,
        url: effectiveSiteUrl(site, deps.baseDomain!),
        websiteUrlSet: filledWebsite,
      });
      res.json({ data: present(site) });
    }),
  );

  router.post(
    '/unpublish',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (!existing) throw new NotFoundError('Tenant site', tenantId);

      const site = await deps.siteRepo.setPublished(tenantId, false, now());
      if (!site) throw new NotFoundError('Tenant site', tenantId);

      let clearedWebsite = false;
      if (deps.baseDomain) {
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const current = settings?.websiteUrl?.trim().toLowerCase();
        // The connected domain serves nothing while unpublished either.
        if (current === siteUrl(site.slug) || (site.customDomain && current === `https://${site.customDomain.domain}`)) {
          await deps.settingsRepo.update(tenantId, { websiteUrl: null });
          clearedWebsite = true;
        }
      }
      await audit(req, 'tenant_site.unpublished', { slug: site.slug, websiteUrlCleared: clearedWebsite });
      res.json({ data: present(site) });
    }),
  );

  // --- #1770 connect a domain you own ---------------------------------------
  const domainSchema = z.object({ domain: z.string().max(300) });

  function domainCheckDeps(baseDomain: string, domain: NonNullable<TenantSiteRouteDeps['domain']>) {
    return {
      baseDomain,
      siteRepo: deps.siteRepo,
      settingsRepo: deps.settingsRepo,
      auditRepo: deps.auditRepo,
      dns: domain.dns,
      provider: domain.provider,
      now,
    };
  }

  router.put(
    '/domain',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { baseDomain, domain: domainDeps } = requireDomainEnabled();
      const tenantId = req.auth!.tenantId;
      const domain = normalizeDomain(domainSchema.parse(req.body).domain);
      const problem = domainProblem(domain, baseDomain, domainDeps.reservedHosts);
      if (problem) throw new ValidationError(DOMAIN_PROBLEM_MESSAGES[problem], { problem });

      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (!existing) throw new ValidationError('Pick an address for your site first');
      if (existing.customDomain?.domain === domain) {
        res.json({ data: present(existing) });
        return;
      }
      if (await deps.siteRepo.isDomainTaken(domain, tenantId)) {
        throw new ConflictError(customDomainErrorMessage('domain_taken') ?? '', { problem: 'domain_taken' });
      }

      // Replacing a domain releases the old one first, so its slot and website setting do not linger.
      if (existing.customDomain) {
        await releaseWebsiteFromDomain(tenantId, existing.customDomain.domain, null);
        await dropFromProvider(existing.customDomain.domain, existing.customDomain.providerRef);
      }
      const claimed = await deps.siteRepo.setCustomDomain(tenantId, domain, now());
      if (!claimed) throw new NotFoundError('Tenant site', tenantId);
      await audit(req, 'tenant_site.domain_set', {
        domain,
        previousDomain: existing.customDomain?.domain ?? null,
        target: cnameTarget(claimed.slug, baseDomain),
      });
      // The record may already be in place: check now rather than leave the owner waiting on the sweep.
      const checked = await checkCustomDomain(domainCheckDeps(baseDomain, domainDeps), claimed, {
        userId: req.auth!.userId,
        role: req.auth!.role,
      });
      res.json({ data: present(checked ?? claimed) });
    }),
  );

  router.post(
    '/domain/check',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { baseDomain, domain: domainDeps } = requireDomainEnabled();
      const tenantId = req.auth!.tenantId;
      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (!existing?.customDomain) throw new ValidationError('Connect a domain first');
      if (existing.customDomain.status === 'verified') {
        res.json({ data: present(existing) });
        return;
      }
      // "Check again" also restarts a claim the sweep gave up on.
      const restarted = await deps.siteRepo.restartCustomDomain(tenantId, now());
      if (!restarted) throw new NotFoundError('Tenant site', tenantId);
      await audit(req, 'tenant_site.domain_check_requested', { domain: restarted.customDomain?.domain });
      const checked = await checkCustomDomain(domainCheckDeps(baseDomain, domainDeps), restarted, {
        userId: req.auth!.userId,
        role: req.auth!.role,
      });
      res.json({ data: present(checked ?? restarted) });
    }),
  );

  router.delete(
    '/domain',
    ...guard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const existing = await deps.siteRepo.findByTenant(tenantId);
      if (!existing?.customDomain) throw new NotFoundError('Connected domain', tenantId);
      const { domain, providerRef } = existing.customDomain;

      await dropFromProvider(domain, providerRef);
      const site = await deps.siteRepo.clearCustomDomain(tenantId);
      // The website setting goes back to the tenant site while that is live, else it is cleared.
      const fallback = existing.published && deps.baseDomain ? siteUrl(existing.slug) : null;
      const websiteUrlReset = await releaseWebsiteFromDomain(tenantId, domain, fallback);
      await audit(req, 'tenant_site.domain_removed', { domain, websiteUrlReset });
      res.json({ data: present(site) });
    }),
  );

  return router;
}
