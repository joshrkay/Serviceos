/**
 * D-044 / #1770 — connect a domain you own: domain validation, backoff, the
 * check step (mocked DNS + certificate provider) and the leader-gated sweep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_DOMAIN_MAX_ATTEMPTS,
  checkCustomDomain,
  cnameTarget,
  customDomainBackoffMs,
  customDomainErrorMessage,
  domainProblem,
  normalizeDomain,
} from '../../src/tenant-site/custom-domain';
import type { CertificateProvider, CertificateState, DnsResolver } from '../../src/tenant-site/custom-domain';
import { InMemoryTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { runCustomDomainSweep } from '../../src/workers/custom-domain-sweep';

const BASE = 'sites.example-pages.test';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const DOMAIN = 'www.joesplumbing.test';
const T0 = new Date('2026-10-22T12:00:00Z');

describe('normalizeDomain / domainProblem', () => {
  it('strips what owners paste', () => {
    expect(normalizeDomain('  HTTPS://WWW.JoesPlumbing.test/about?x=1 ')).toBe(DOMAIN);
    expect(normalizeDomain('www.joesplumbing.test:8080')).toBe(DOMAIN);
    expect(normalizeDomain('www.joesplumbing.test.')).toBe(DOMAIN);
  });

  it('accepts a subdomain and names each problem otherwise', () => {
    const reserved = ['app.example.test', 'api.example.test'];
    expect(domainProblem(DOMAIN, BASE, reserved)).toBeNull();
    expect(domainProblem('joesplumbing.test', BASE, reserved)).toBe('needs_subdomain');
    expect(domainProblem('not a domain', BASE, reserved)).toBe('malformed');
    expect(domainProblem('10.0.0.1', BASE, reserved)).toBe('malformed');
    expect(domainProblem('localhost', BASE, reserved)).toBe('malformed');
    expect(domainProblem(`joe.${BASE}`, BASE, reserved)).toBe('reserved');
    expect(domainProblem('app.example.test', BASE, reserved)).toBe('reserved');
    expect(domainProblem('login.app.example.test', BASE, reserved)).toBe('reserved');
  });
});

describe('customDomainBackoffMs', () => {
  it('doubles from a minute and caps at an hour', () => {
    expect([1, 2, 3, 4].map(customDomainBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(customDomainBackoffMs(7)).toBe(3_600_000);
    expect(customDomainBackoffMs(500)).toBe(3_600_000);
  });
});

describe('checkCustomDomain', () => {
  let siteRepo: InMemoryTenantSiteRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let cnames: Record<string, string[] | Error>;
  let certState: CertificateState | Error;
  let provider: CertificateProvider & { register: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let now: Date;

  const dns: DnsResolver = {
    async resolveCname(host) {
      const v = cnames[host] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
  };

  const deps = () => ({ baseDomain: BASE, siteRepo, settingsRepo, auditRepo, dns, provider, now: () => now });

  async function claim(tenantId = T1, slug = 'joes-plumbing', domain = DOMAIN) {
    await siteRepo.setSlug(tenantId, slug);
    return (await siteRepo.setCustomDomain(tenantId, domain, now))!;
  }

  beforeEach(async () => {
    siteRepo = new InMemoryTenantSiteRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    cnames = {};
    certState = 'pending';
    now = new Date(T0);
    provider = {
      name: 'fake',
      register: vi.fn(async () => ({ ref: 'ref-1' })),
      status: vi.fn(async () => {
        if (certState instanceof Error) throw certState;
        return certState;
      }),
      remove: vi.fn(async () => undefined),
    };
    await settingsRepo.upsertIdentityFields(T1, { businessName: "Joe's Plumbing" });
    await settingsRepo.upsertIdentityFields(T2, { businessName: 'Other Co' });
  });

  it('a missing CNAME stays pending_dns with a plain error and a backoff', async () => {
    const site = await claim();
    const out = await checkCustomDomain(deps(), site);
    expect(out!.customDomain).toMatchObject({ status: 'pending_dns', error: 'dns_missing', attempts: 1 });
    expect(out!.customDomain!.nextCheckAt).toEqual(new Date(T0.getTime() + 60_000));
    expect(customDomainErrorMessage('dns_missing')).toMatch(/CNAME/);
    expect(provider.register).not.toHaveBeenCalled();
  });

  it('a CNAME to somewhere else is a different error, and another tenant\'s address does not pass', async () => {
    const site = await claim();
    cnames[DOMAIN] = ['someone-else.example.net.'];
    expect((await checkCustomDomain(deps(), site))!.customDomain!.error).toBe('dns_wrong');
    cnames[DOMAIN] = [cnameTarget('other-co', BASE)];
    expect((await checkCustomDomain(deps(), site))!.customDomain!.error).toBe('dns_wrong');
    expect(provider.register).not.toHaveBeenCalled();
  });

  it('a DNS lookup failure is retried, not blamed on the owner', async () => {
    const site = await claim();
    cnames[DOMAIN] = new Error('SERVFAIL');
    const out = await checkCustomDomain(deps(), site);
    expect(out!.customDomain).toMatchObject({ status: 'pending_dns', error: 'dns_lookup_failed' });
  });

  it('DNS ok registers once, waits for the certificate, then verifies and switches the website', async () => {
    const site = await claim();
    cnames[DOMAIN] = [`${cnameTarget('joes-plumbing', BASE)}.`]; // trailing dot, as resolvers return it
    await settingsRepo.update(T1, { websiteUrl: `https://${cnameTarget('joes-plumbing', BASE)}` });

    const waiting = await checkCustomDomain(deps(), site);
    expect(waiting!.customDomain).toMatchObject({ status: 'pending_certificate', error: null, providerRef: 'ref-1' });
    expect(provider.register).toHaveBeenCalledTimes(1);

    certState = 'issued';
    now = new Date(T0.getTime() + 120_000);
    const done = await checkCustomDomain(deps(), waiting!);
    expect(provider.register).toHaveBeenCalledTimes(1); // the stored ref is reused
    expect(done!.customDomain).toMatchObject({ status: 'verified', error: null, nextCheckAt: null });
    expect(done!.customDomain!.verifiedAt).toEqual(now);

    expect((await settingsRepo.findByTenant(T1))!.websiteUrl).toBe(`https://${DOMAIN}`);
    const events = await auditRepo.findByEntity(T1, 'tenant_site', T1);
    expect(events.map((e) => e.eventType)).toEqual(['tenant_site.domain_verified']);
    expect(events[0].metadata).toMatchObject({ domain: DOMAIN, websiteUrlSet: true });
  });

  it("verifying leaves an owner's own website URL alone", async () => {
    const site = await claim();
    cnames[DOMAIN] = [cnameTarget('joes-plumbing', BASE)];
    certState = 'issued';
    await settingsRepo.update(T1, { websiteUrl: 'https://joesplumbing.com' });
    await checkCustomDomain(deps(), site);
    expect((await settingsRepo.findByTenant(T1))!.websiteUrl).toBe('https://joesplumbing.com');
  });

  it('a failed certificate and a provider outage are their own errors', async () => {
    const site = await claim();
    cnames[DOMAIN] = [cnameTarget('joes-plumbing', BASE)];
    certState = 'failed';
    expect((await checkCustomDomain(deps(), site))!.customDomain).toMatchObject({
      status: 'pending_certificate',
      error: 'certificate_failed',
    });

    const fresh = await claim(T2, 'other-co', 'www.other.test');
    cnames['www.other.test'] = [cnameTarget('other-co', BASE)];
    provider.register.mockRejectedValueOnce(new Error('Railway 500'));
    expect((await checkCustomDomain(deps(), fresh))!.customDomain).toMatchObject({
      status: 'pending_dns',
      error: 'certificate_unavailable',
      providerRef: null,
    });
  });

  it('two tenants cannot both verify one domain: the second gets domain_taken and stops', async () => {
    const first = await claim(T1, 'joes-plumbing');
    const second = await claim(T2, 'other-co');
    cnames[DOMAIN] = [cnameTarget('joes-plumbing', BASE), cnameTarget('other-co', BASE)];
    certState = 'issued';
    expect((await checkCustomDomain(deps(), first))!.customDomain!.status).toBe('verified');
    const out = await checkCustomDomain(deps(), second);
    expect(out!.customDomain).toMatchObject({ status: 'failed', error: 'domain_taken', nextCheckAt: null });
    expect(await siteRepo.isDomainTaken(DOMAIN, T2)).toBe(true);
  });

  it('gives up after the attempt budget and audits it', async () => {
    const site = await claim();
    const nearly = await siteRepo.updateCustomDomain(T1, DOMAIN, { attempts: CUSTOM_DOMAIN_MAX_ATTEMPTS - 1 });
    const out = await checkCustomDomain(deps(), nearly!);
    expect(out!.customDomain).toMatchObject({ status: 'failed', error: 'dns_missing', nextCheckAt: null });
    const events = await auditRepo.findByEntity(T1, 'tenant_site', T1);
    expect(events.map((e) => e.eventType)).toEqual(['tenant_site.domain_failed']);
    expect(site.customDomain!.status).toBe('pending_dns');
    // A failed claim is not advanced by a stray check; the owner restarts it.
    expect(await checkCustomDomain(deps(), out!)).toBe(out);
  });

  it('is a no-op for a verified or absent domain', async () => {
    await siteRepo.setSlug(T1, 'joes-plumbing');
    const bare = (await siteRepo.findByTenant(T1))!;
    expect(await checkCustomDomain(deps(), bare)).toBe(bare);
  });
});

describe('runCustomDomainSweep', () => {
  it('checks only what is due, isolates a failing claim, and counts verifications', async () => {
    const siteRepo = new InMemoryTenantSiteRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const auditRepo = new InMemoryAuditRepository();
    const now = new Date(T0);

    await siteRepo.setSlug(T1, 'joes-plumbing');
    await siteRepo.setCustomDomain(T1, DOMAIN, now);
    await siteRepo.setSlug(T2, 'other-co');
    await siteRepo.setCustomDomain(T2, 'www.other.test', now);
    const T3 = '33333333-3333-4333-8333-333333333333';
    await siteRepo.setSlug(T3, 'later-co');
    await siteRepo.setCustomDomain(T3, 'www.later.test', new Date(now.getTime() + 3_600_000)); // not due yet

    const lookups: string[] = [];
    const dns: DnsResolver = {
      async resolveCname(host) {
        lookups.push(host);
        if (host === 'www.other.test') throw new Error('boom');
        return [cnameTarget('joes-plumbing', BASE)];
      },
    };
    const provider: CertificateProvider = {
      name: 'fake',
      register: async () => ({ ref: 'r' }),
      status: async () => 'issued',
      remove: async () => undefined,
    };
    // Make T2's claim throw out of the check step (not just a handled DNS error).
    const failing = Object.assign(Object.create(siteRepo), {
      updateCustomDomain: async (tenantId: string, ...rest: unknown[]) => {
        if (tenantId === T2) throw new Error('db down');
        return (siteRepo.updateCustomDomain as (...a: unknown[]) => unknown)(tenantId, ...rest);
      },
    }) as InMemoryTenantSiteRepository;
    const logger = { error: vi.fn() };

    const result = await runCustomDomainSweep({
      baseDomain: BASE,
      siteRepo: failing,
      settingsRepo,
      auditRepo,
      dns,
      provider,
      logger,
      now: () => now,
    });

    expect(result).toEqual({ due: 2, verified: 1, failed: 1 });
    expect(lookups.sort()).toEqual([DOMAIN, 'www.other.test']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((await siteRepo.findByTenant(T1))!.customDomain!.status).toBe('verified');
    expect((await siteRepo.findByTenant(T3))!.customDomain!.attempts).toBe(0);
  });
});
