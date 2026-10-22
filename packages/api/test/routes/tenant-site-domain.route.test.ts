/**
 * D-044 / #1770 — /api/tenant-site/domain: connect a domain you own. Owner
 * only, audited, one CNAME record shown, plain error states, and the website
 * setting follows the domain once it is verified (and back when removed).
 */
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantSiteRouter } from '../../src/routes/tenant-site';
import { InMemoryTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { toErrorResponse } from '../../src/shared/errors';
import { TenantSiteAboutTask } from '../../src/ai/tasks/tenant-site-about-task';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { CertificateProvider, CertificateState, DnsResolver } from '../../src/tenant-site/custom-domain';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'sites.example-pages.test';
const DOMAIN = 'www.joesplumbing.test';
const TARGET = `joes-plumbing.${BASE}`;

describe('/api/tenant-site/domain', () => {
  let siteRepo: InMemoryTenantSiteRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let cnames: Record<string, string[]>;
  let certState: CertificateState;
  let provider: CertificateProvider & { remove: ReturnType<typeof vi.fn> };

  const dns: DnsResolver = { resolveCname: async (host) => cnames[host] ?? [] };

  beforeEach(async () => {
    siteRepo = new InMemoryTenantSiteRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    cnames = {};
    certState = 'pending';
    provider = {
      name: 'fake',
      register: async () => ({ ref: 'ref-1' }),
      status: async () => certState,
      remove: vi.fn(async () => undefined),
    };
    await settingsRepo.upsertIdentityFields(TENANT, { businessName: "Joe's Plumbing" });
    await settingsRepo.upsertIdentityFields(OTHER, { businessName: 'Other Co' });
  });

  function app(
    role: NonNullable<AuthenticatedRequest['auth']>['role'] = 'owner',
    opts: { withDomain?: boolean; tenantId?: string } = {},
  ) {
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: opts.tenantId ?? TENANT, role };
      next();
    });
    a.use(
      '/api/tenant-site',
      createTenantSiteRouter({
        baseDomain: BASE,
        siteRepo,
        settingsRepo,
        viewDeps: {
          settingsRepo,
          packRegistry: new InMemoryVerticalPackRegistry(),
          webOrigin: 'https://app.example.test',
        },
        auditRepo,
        aboutTask: new TenantSiteAboutTask(createMockLLMGateway('about').gateway),
        proposalRepo: new InMemoryProposalRepository(),
        ...(opts.withDomain === false
          ? {}
          : { domain: { provider, dns, reservedHosts: ['app.example.test', 'api.example.test'] } }),
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

  async function withSite(publish = true) {
    expect((await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing' })).status).toBe(200);
    if (publish) expect((await request(app()).post('/api/tenant-site/publish')).status).toBe(200);
  }

  it('is off, and says so, without a certificate provider', async () => {
    const off = app('owner', { withDomain: false });
    expect((await request(off).get('/api/tenant-site')).body.data.domainConnectEnabled).toBe(false);
    const res = await request(off).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not available yet/);
    expect((await request(app()).get('/api/tenant-site')).body.data.domainConnectEnabled).toBe(true);
  });

  it('needs an address first', async () => {
    const res = await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/address/);
  });

  it('is owner-only', async () => {
    await withSite();
    for (const role of ['dispatcher', 'technician'] as const) {
      expect((await request(app(role)).put('/api/tenant-site/domain').send({ domain: DOMAIN })).status, role).toBe(403);
      expect((await request(app(role)).post('/api/tenant-site/domain/check')).status, role).toBe(403);
      expect((await request(app(role)).delete('/api/tenant-site/domain')).status, role).toBe(403);
    }
  });

  it('rejects domains it cannot use, with a reason', async () => {
    await withSite();
    for (const [domain, snippet] of [
      ['joesplumbing.test', /bare domain/],
      ['not a domain', /just the domain/],
      [`joe.${BASE}`, /cannot be connected/],
      ['app.example.test', /cannot be connected/],
    ] as const) {
      const res = await request(app()).put('/api/tenant-site/domain').send({ domain });
      expect(res.status, domain).toBe(400);
      expect(res.body.message, domain).toMatch(snippet);
    }
    expect(await events()).not.toContain('tenant_site.domain_set');
  });

  it('shows the one CNAME record and a plain error while it is missing; audited', async () => {
    await withSite();
    const res = await request(app()).put('/api/tenant-site/domain').send({ domain: ` HTTPS://${DOMAIN.toUpperCase()}/ ` });
    expect(res.status).toBe(200);
    expect(res.body.data.domain).toMatchObject({
      domain: DOMAIN,
      status: 'pending_dns',
      verified: false,
      record: { type: 'CNAME', host: DOMAIN, value: TARGET },
      error: { code: 'dns_missing' },
    });
    expect(res.body.data.domain.error.message).toMatch(/CNAME/);
    expect(await events()).toContain('tenant_site.domain_set');
  });

  it('verifies when the record and certificate are in place and switches the website setting', async () => {
    await withSite();
    const website = async () => (await settingsRepo.findByTenant(TENANT))!.websiteUrl;
    expect(await website()).toBe(`https://${TARGET}`);

    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    cnames[DOMAIN] = [TARGET];
    const waiting = await request(app()).post('/api/tenant-site/domain/check');
    expect(waiting.body.data.domain).toMatchObject({ status: 'pending_certificate', error: null });
    expect(await website()).toBe(`https://${TARGET}`);

    certState = 'issued';
    const done = await request(app()).post('/api/tenant-site/domain/check');
    expect(done.body.data.domain).toMatchObject({ status: 'verified', verified: true, url: `https://${DOMAIN}` });
    expect(await website()).toBe(`https://${DOMAIN}`);
    expect(await events()).toEqual(
      expect.arrayContaining(['tenant_site.domain_set', 'tenant_site.domain_check_requested', 'tenant_site.domain_verified']),
    );

    // The existing state shows through GET.
    expect((await request(app()).get('/api/tenant-site')).body.data.site.domain.verified).toBe(true);
  });

  it('removing the domain releases the provider and points the website back at the tenant site', async () => {
    await withSite();
    cnames[DOMAIN] = [TARGET];
    certState = 'issued';
    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    expect((await settingsRepo.findByTenant(TENANT))!.websiteUrl).toBe(`https://${DOMAIN}`);

    const res = await request(app()).delete('/api/tenant-site/domain');
    expect(res.status).toBe(200);
    expect(res.body.data.domain).toBeNull();
    expect(provider.remove).toHaveBeenCalledWith(DOMAIN, 'ref-1');
    expect((await settingsRepo.findByTenant(TENANT))!.websiteUrl).toBe(`https://${TARGET}`);
    expect(await events()).toContain('tenant_site.domain_removed');
    expect((await request(app()).delete('/api/tenant-site/domain')).status).toBe(404);
  });

  it('replacing a verified domain releases the old one', async () => {
    await withSite();
    cnames[DOMAIN] = [TARGET];
    certState = 'issued';
    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    const res = await request(app()).put('/api/tenant-site/domain').send({ domain: 'www.joes.test' });
    expect(res.body.data.domain).toMatchObject({ domain: 'www.joes.test', status: 'pending_dns' });
    expect(provider.remove).toHaveBeenCalledWith(DOMAIN, 'ref-1');
    expect((await settingsRepo.findByTenant(TENANT))!.websiteUrl).toBeNull();
  });

  it("another business's verified domain is a conflict; an unverified claim does not block", async () => {
    await withSite();
    await request(app('owner', { tenantId: OTHER })).put('/api/tenant-site/address').send({ slug: 'other-co' });
    const other = () => app('owner', { tenantId: OTHER });
    // Other Co merely claims it (unverified): Joe can still claim it too.
    await request(other()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    expect((await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN })).status).toBe(200);

    cnames[DOMAIN] = [TARGET, `other-co.${BASE}`];
    certState = 'issued';
    await request(app()).post('/api/tenant-site/domain/check');
    // Other Co's own check can no longer verify it: Joe holds it.
    const lost = await request(other()).post('/api/tenant-site/domain/check');
    expect(lost.body.data.domain).toMatchObject({ status: 'failed', error: { code: 'domain_taken' } });

    await request(other()).put('/api/tenant-site/domain').send({ domain: 'www.other.test' });
    const res = await request(other()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already connected/);
  });

  it('a stuck claim the sweep gave up on restarts on "check again"', async () => {
    await withSite();
    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    await siteRepo.updateCustomDomain(TENANT, DOMAIN, { status: 'failed', error: 'dns_missing', nextCheckAt: null, attempts: 60 });
    cnames[DOMAIN] = [TARGET];
    const res = await request(app()).post('/api/tenant-site/domain/check');
    expect(res.body.data.domain).toMatchObject({ status: 'pending_certificate', error: null });
    expect((await siteRepo.findByTenant(TENANT))!.customDomain!.attempts).toBe(1); // restarted, then this check counted
  });

  it('changing the address sends a connected domain back to verification', async () => {
    await withSite(false);
    cnames[DOMAIN] = [TARGET];
    certState = 'issued';
    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    const res = await request(app()).put('/api/tenant-site/address').send({ slug: 'joes-plumbing-co' });
    expect(res.status).toBe(200);
    expect(res.body.data.domain).toMatchObject({
      status: 'pending_dns',
      record: { value: `joes-plumbing-co.${BASE}` },
    });
    expect(provider.remove).toHaveBeenCalled();
  });

  it('unpublishing clears a website setting that names the connected domain', async () => {
    await withSite();
    cnames[DOMAIN] = [TARGET];
    certState = 'issued';
    await request(app()).put('/api/tenant-site/domain').send({ domain: DOMAIN });
    await request(app()).post('/api/tenant-site/unpublish');
    expect((await settingsRepo.findByTenant(TENANT))!.websiteUrl).toBeNull();
    // Publishing again puts the connected domain back, since it is still verified.
    await request(app()).post('/api/tenant-site/publish');
    expect((await settingsRepo.findByTenant(TENANT))!.websiteUrl).toBe(`https://${DOMAIN}`);
  });
});
