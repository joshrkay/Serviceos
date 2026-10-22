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
import { renderTenantSitePage } from '../tenant-site/render';
import { loadTenantSiteView } from '../tenant-site/view';
import type { TenantSiteViewDeps } from '../tenant-site/view';
import { resolvePublicServiceTypes } from '../public-intake/public-business-info';
import { createProposal, ProposalRepository } from '../proposals/proposal';
import { rejectProposal } from '../proposals/actions';
import type { TenantSiteAboutTask } from '../ai/tasks/tenant-site-about-task';
import type { Role } from '../auth/rbac';

/**
 * D-044 / #1768 — the owner's hosted-site controls (Settings → Website).
 *
 *   GET  /api/tenant-site          — address, live state, the site URL
 *   GET  /api/tenant-site/check    — is this address usable?
 *   PUT  /api/tenant-site/address  — pick the address (while unpublished)
 *   GET  /api/tenant-site/preview  — the page as it would render, as HTML text
 *   POST /api/tenant-site/publish
 *   POST /api/tenant-site/unpublish
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
  now?: () => Date;
}

const PENDING_STATUSES = ['draft', 'ready_for_review'] as const;

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

  function present(site: TenantSite | null) {
    return site
      ? {
          slug: site.slug,
          published: site.published,
          publishedAt: site.publishedAt ? site.publishedAt.toISOString() : null,
          url: siteUrl(site.slug),
        }
      : null;
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
      const { aboutText } = await deps.aboutTask.draft({
        tenantId,
        businessName: settings.businessName.trim(),
        services,
        serviceArea: settings.serviceAreaText ?? null,
        brandVoice: settings.brandVoice ?? null,
      });

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
      const proposal = createProposal({
        tenantId,
        proposalType: 'update_tenant_site_about',
        payload: { aboutText },
        summary: 'Add an "About us" section to your website',
        explanation: 'Drafted from your business name, services and service area. Edit it before approving if you like.',
        createdBy: req.auth!.userId,
        targetEntityType: 'tenant_site',
        targetEntityId: tenantId,
      });
      await deps.proposalRepo.create(proposal);
      await audit(req, 'tenant_site.about_drafted', { proposalId: proposal.id, length: aboutText.length });
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
        await deps.settingsRepo.update(tenantId, { websiteUrl: siteUrl(site.slug) });
      }
      await audit(req, 'tenant_site.published', {
        slug: site.slug,
        url: siteUrl(site.slug),
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
        if (settings?.websiteUrl?.trim().toLowerCase() === siteUrl(site.slug)) {
          await deps.settingsRepo.update(tenantId, { websiteUrl: null });
          clearedWebsite = true;
        }
      }
      await audit(req, 'tenant_site.unpublished', { slug: site.slug, websiteUrlCleared: clearedWebsite });
      res.json({ data: present(site) });
    }),
  );

  return router;
}
