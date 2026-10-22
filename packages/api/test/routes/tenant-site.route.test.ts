/**
 * D-044 / #1768 — /api/tenant-site: pick an address (taken / reserved /
 * malformed give clear errors), preview, publish and unpublish. Owner-only and
 * audited; publishing fills the website URL, unpublishing clears only ours.
 */
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTenantSiteRouter } from '../../src/routes/tenant-site';
import { InMemoryTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { toErrorResponse } from '../../src/shared/errors';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { approveProposal, editProposal, rejectProposal } from '../../src/proposals/actions';
import { UpdateTenantSiteAboutExecutionHandler } from '../../src/proposals/execution/tenant-site-about-handler';
import { TenantSiteAboutTask } from '../../src/ai/tasks/tenant-site-about-task';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { loadTenantSiteView } from '../../src/tenant-site/view';
import { renderTenantSitePage } from '../../src/tenant-site/render';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-site-1';
const OTHER = 'tenant-site-2';
const BASE = 'sites.example-pages.test';

describe('/api/tenant-site', () => {
  let siteRepo: InMemoryTenantSiteRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;
  let gateway: ReturnType<typeof createMockLLMGateway>;

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    gateway = createMockLLMGateway("Joe's Plumbing keeps Austin's pipes flowing. Call us for a quote.");
    siteRepo = new InMemoryTenantSiteRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    await settingsRepo.upsertIdentityFields(TENANT, { businessName: "Joe's Plumbing" });
    await settingsRepo.upsertIdentityFields(OTHER, { businessName: 'Other Co' });
  });

  function app(
    role: NonNullable<AuthenticatedRequest['auth']>['role'] = 'owner',
    opts: { baseDomain?: string | undefined; tenantId?: string } = {},
  ) {
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u1',
        sessionId: 's1',
        tenantId: opts.tenantId ?? TENANT,
        role,
      };
      next();
    });
    a.use(
      '/api/tenant-site',
      createTenantSiteRouter({
        baseDomain: 'baseDomain' in opts ? opts.baseDomain : BASE,
        siteRepo,
        settingsRepo,
        viewDeps: {
          settingsRepo,
          packRegistry: new InMemoryVerticalPackRegistry(),
          webOrigin: 'https://app.example.test',
        },
        auditRepo,
        aboutTask: new TenantSiteAboutTask(gateway.gateway),
        proposalRepo,
      }),
    );
    a.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    });
    return a;
  }

  const events = async (tenantId = TENANT) =>
    (await auditRepo.findByEntity(tenantId, 'tenant_site', tenantId)).map((e) => e.eventType);

  it('starts with no site and suggests an address from the business name', async () => {
    const res = await request(app()).get('/api/tenant-site');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      enabled: true,
      domainConnectEnabled: false,
      baseDomain: BASE,
      site: null,
      suggestedSlug: 'joes-plumbing',
      websiteUrl: null,
    });
  });

  it('is off, and says so, when no tenant-site domain is configured', async () => {
    const off = app('owner', { baseDomain: undefined });
    expect((await request(off).get('/api/tenant-site')).body.data).toMatchObject({ enabled: false, baseDomain: null });
    const res = await request(off).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not available yet/);
    expect((await request(off).post('/api/tenant-site/publish')).status).toBe(400);
  });

  describe('address', () => {
    it('saves a valid address (any case) unpublished and audits it', async () => {
      const res = await request(app()).put('/api/tenant-site/address').send({ slug: ' Joes-Plumbing ' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        slug: 'joes-plumbing',
        published: false,
        url: `https://joes-plumbing.${BASE}`,
      });
      expect(await events()).toEqual(['tenant_site.address_set']);
    });

    it.each([
      ['ab', 'at least'],
      ['-bad-', 'lowercase letters'],
      ['has space', 'lowercase letters'],
      ['www', 'reserved'],
      ['admin', 'reserved'],
    ])('refuses %s with a clear message', async (slug, wording) => {
      const res = await request(app()).put('/api/tenant-site/address').send({ slug });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(wording);
      expect(await siteRepo.findByTenant(TENANT)).toBeNull();
    });

    it('refuses an address another business has, published or not', async () => {
      await request(app('owner', { tenantId: OTHER })).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      const res = await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already taken/);

      const check = await request(app()).get('/api/tenant-site/check').query({ slug: 'joes-plumbing' });
      expect(check.body.data).toMatchObject({ available: false, problem: 'taken' });
      const free = await request(app()).get('/api/tenant-site/check').query({ slug: 'joes-plumbing-2' });
      expect(free.body.data).toMatchObject({ available: true });
    });

    it('re-saving your own address is fine', async () => {
      await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      const again = await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      expect(again.status).toBe(200);
      expect(await events()).toEqual(['tenant_site.address_set']);
    });

    it('cannot be changed while live', async () => {
      await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      await request(app()).post('/api/tenant-site/publish');
      const res = await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-heating' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unpublish/);
    });
  });

  describe('publish / unpublish', () => {
    it('publish needs an address first', async () => {
      const res = await request(app()).post('/api/tenant-site/publish');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/address/);
    });

    it('publishes, fills the website URL and audits; unpublish clears it and audits', async () => {
      await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      const live = await request(app()).post('/api/tenant-site/publish');
      expect(live.status).toBe(200);
      expect(live.body.data).toMatchObject({ published: true });
      expect((await settingsRepo.findByTenant(TENANT))?.websiteUrl).toBe(`https://joes-plumbing.${BASE}`);
      expect((await siteRepo.findPublishedBySlug('joes-plumbing'))?.tenantId).toBe(TENANT);

      const down = await request(app()).post('/api/tenant-site/unpublish');
      expect(down.body.data).toMatchObject({ published: false });
      expect((await settingsRepo.findByTenant(TENANT))?.websiteUrl).toBeFalsy();
      expect(await siteRepo.findPublishedBySlug('joes-plumbing')).toBeNull();

      expect(await events()).toEqual(['tenant_site.address_set', 'tenant_site.published', 'tenant_site.unpublished']);
      const published = (await auditRepo.findByEntity(TENANT, 'tenant_site', TENANT))[1]!;
      expect(published).toMatchObject({ actorId: 'u1', actorRole: 'owner', metadata: { slug: 'joes-plumbing', websiteUrlSet: true } });
    });

    it("never overwrites, or clears, the owner's own website", async () => {
      await settingsRepo.update(TENANT, { websiteUrl: 'https://joesplumbing.com' });
      await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' });
      await request(app()).post('/api/tenant-site/publish');
      expect((await settingsRepo.findByTenant(TENANT))?.websiteUrl).toBe('https://joesplumbing.com');
      await request(app()).post('/api/tenant-site/unpublish');
      expect((await settingsRepo.findByTenant(TENANT))?.websiteUrl).toBe('https://joesplumbing.com');
    });

    it('unpublish without a site is a 404', async () => {
      expect((await request(app()).post('/api/tenant-site/unpublish')).status).toBe(404);
    });
  });

  describe('preview', () => {
    it('renders the page from settings without publishing', async () => {
      const res = await request(app()).get('/api/tenant-site/preview');
      expect(res.status).toBe(200);
      expect(res.body.data.html).toContain('Joe&#39;s Plumbing');
      expect(await siteRepo.findByTenant(TENANT)).toBeNull();
    });
  });

  describe('about copy (#1769)', () => {
    const viewDeps = () => ({
      settingsRepo,
      packRegistry: new InMemoryVerticalPackRegistry(),
      webOrigin: 'https://app.example.test',
    });
    const runApproved = async (id: string) => {
      const proposal = (await proposalRepo.findById(TENANT, id))!;
      return new UpdateTenantSiteAboutExecutionHandler(settingsRepo, auditRepo).execute(proposal, {
        tenantId: TENANT,
        executedBy: 'u1',
        executedByRole: 'owner',
      });
    };

    it('starts with no about copy and nothing pending', async () => {
      const res = await request(app()).get('/api/tenant-site/about');
      expect(res.body.data).toEqual({ current: null, pending: null });
    });

    it('drafts through the gateway into a manual proposal, writing nothing to the site', async () => {
      const res = await request(app()).post('/api/tenant-site/about/draft');
      expect(res.status).toBe(201);
      expect(res.body.data.aboutText).toContain('keeps Austin');

      const calls = gateway.provider.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.taskType).toBe('tenant_site_about');
      expect(calls[0]!.messages.map((m) => m.content).join('\n')).toContain("Business name: Joe's Plumbing");

      const proposal = (await proposalRepo.findById(TENANT, res.body.data.proposalId))!;
      expect(proposal).toMatchObject({
        proposalType: 'update_tenant_site_about',
        status: 'draft',
        payload: { aboutText: res.body.data.aboutText },
      });
      // Nothing is live until the owner approves.
      expect((await settingsRepo.findByTenant(TENANT))?.siteAboutText).toBeFalsy();
      expect((await request(app()).get('/api/tenant-site/about')).body.data).toEqual({
        current: null,
        pending: { proposalId: proposal.id, aboutText: res.body.data.aboutText },
      });
      expect(await events()).toEqual(['tenant_site.about_drafted']);
    });

    it('approving sets the about copy (after an owner edit) and the page shows it', async () => {
      const draft = (await request(app()).post('/api/tenant-site/about/draft')).body.data;

      await editProposal(
        proposalRepo,
        TENANT,
        draft.proposalId,
        'u1',
        'owner',
        { aboutText: 'Family-run plumbers in Austin.' },
        auditRepo,
      );
      await approveProposal(proposalRepo, TENANT, draft.proposalId, 'u1', 'owner', auditRepo);
      // Approval alone does not publish copy; the execution handler does.
      expect((await settingsRepo.findByTenant(TENANT))?.siteAboutText).toBeFalsy();

      expect(await runApproved(draft.proposalId)).toMatchObject({ success: true });
      expect((await request(app()).get('/api/tenant-site/about')).body.data).toEqual({
        current: 'Family-run plumbers in Austin.',
        pending: null,
      });
      const view = (await loadTenantSiteView(viewDeps(), TENANT))!;
      expect(renderTenantSitePage(view)).toContain('<h2>About us</h2><p>Family-run plumbers in Austin.</p>');
      const original = (await proposalRepo.findById(TENANT, draft.proposalId))!.originalPayload;
      expect(original?.aboutText).toContain('keeps Austin');
    });

    it('rejecting leaves the site without about copy, and the page still renders', async () => {
      const draft = (await request(app()).post('/api/tenant-site/about/draft')).body.data;
      await rejectProposal(
        proposalRepo,
        TENANT,
        draft.proposalId,
        'u1',
        'owner',
        'not_right',
        undefined,
        undefined,
        auditRepo,
      );

      expect((await settingsRepo.findByTenant(TENANT))?.siteAboutText).toBeFalsy();
      expect((await request(app()).get('/api/tenant-site/about')).body.data).toEqual({ current: null, pending: null });
      const html = renderTenantSitePage((await loadTenantSiteView(viewDeps(), TENANT))!);
      expect(html).not.toContain('About us');
      expect(html).toContain('Get in touch');
    });

    it('a new draft replaces the one awaiting approval', async () => {
      const first = (await request(app()).post('/api/tenant-site/about/draft')).body.data;
      const second = (await request(app()).post('/api/tenant-site/about/draft')).body.data;
      expect(second.proposalId).not.toBe(first.proposalId);
      expect((await proposalRepo.findById(TENANT, first.proposalId))?.status).toBe('rejected');
      expect((await request(app()).get('/api/tenant-site/about')).body.data.pending.proposalId).toBe(second.proposalId);
    });

    it('needs a business name to draft from', async () => {
      const a = app('owner', { tenantId: 'tenant-without-settings' });
      const res = await request(a).post('/api/tenant-site/about/draft');
      expect(res.status).toBe(400);
      expect(gateway.provider.getCalls()).toHaveLength(0);
    });

    it('is owner-only', async () => {
      for (const role of ['dispatcher', 'technician'] as const) {
        expect((await request(app(role)).post('/api/tenant-site/about/draft')).status).toBe(403);
        expect((await request(app(role)).get('/api/tenant-site/about')).status).toBe(403);
      }
      expect(gateway.provider.getCalls()).toHaveLength(0);
    });
  });

  it('is owner-only: a dispatcher and a technician get 403 on every endpoint', async () => {
    for (const role of ['dispatcher', 'technician'] as const) {
      const a = app(role);
      expect((await request(a).get('/api/tenant-site')).status).toBe(403);
      expect((await request(a).get('/api/tenant-site/check').query({ slug: 'abc' })).status).toBe(403);
      expect((await request(a).put('/api/tenant-site/address').send({ slug: 'abc-co' })).status).toBe(403);
      expect((await request(a).get('/api/tenant-site/preview')).status).toBe(403);
      expect((await request(a).post('/api/tenant-site/publish')).status).toBe(403);
      expect((await request(a).post('/api/tenant-site/unpublish')).status).toBe(403);
    }
    expect(await siteRepo.findByTenant(TENANT)).toBeNull();
  });
});
