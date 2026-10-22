/**
 * D-044 / #1770 — connect a domain the owner already owns to their tenant site.
 *
 * The owner adds ONE record at their registrar: a CNAME from their domain to
 * their site address (`<slug>.<TENANT_SITE_BASE_DOMAIN>`). One check step
 * (`checkCustomDomain`) moves a claim forward: DNS -> a certificate from the
 * `CertificateProvider` -> verified. The verification sweep
 * (workers/custom-domain-sweep.ts) runs it on a backoff; the owner's "check
 * again" runs it on demand. We never buy, sell or renew domains.
 *
 * A domain only verifies for the tenant whose OWN slug its CNAME names, so a
 * claim on someone else's domain can never pass: only whoever controls the
 * domain's DNS can point it at that tenant.
 */
import { Resolver } from 'dns/promises';
import { isIP } from 'net';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { SettingsRepository } from '../settings/settings';
import { TenantSiteDomainTakenError } from './tenant-site';
import type { TenantSite, TenantSiteRepository } from './tenant-site';

// ---------------------------------------------------------------------------
// The two seams: DNS and the certificate provider.
// ---------------------------------------------------------------------------

export interface DnsResolver {
  /** CNAME targets for a host; an empty list when it has none. Throws on a lookup failure (timeout, SERVFAIL). */
  resolveCname(host: string): Promise<string[]>;
}

const NO_RECORD_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);

export function createNodeDnsResolver(): DnsResolver {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  return {
    async resolveCname(host) {
      try {
        return await resolver.resolveCname(host);
      } catch (err) {
        if (NO_RECORD_CODES.has((err as { code?: string }).code ?? '')) return [];
        throw err;
      }
    },
  };
}

export type CertificateState = 'issued' | 'pending' | 'failed';

/**
 * Whatever terminates TLS for the owner's domain. The default is Railway's
 * custom-domain API (railway-certificate-provider.ts); a TLS-for-SaaS provider
 * would be a second implementation of this interface (D-046).
 */
export interface CertificateProvider {
  readonly name: string;
  /** Registers the domain so the edge starts issuing a certificate; idempotent per call site (the ref is stored). */
  register(domain: string): Promise<{ ref: string }>;
  status(domain: string, ref: string): Promise<CertificateState>;
  /** Releases the domain (and its slot on the provider). */
  remove(domain: string, ref: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Domain validation.
// ---------------------------------------------------------------------------

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MIN_LABELS = 3;

export type DomainProblem = 'malformed' | 'needs_subdomain' | 'reserved';

export const DOMAIN_PROBLEM_MESSAGES: Record<DomainProblem, string> = {
  malformed: 'Enter just the domain, like www.yourbusiness.com (no https://, path or port).',
  needs_subdomain:
    'Use a name like www.yourbusiness.com. A bare domain (yourbusiness.com) cannot be pointed with a CNAME record.',
  reserved: 'That domain cannot be connected.',
};

/** Lowercases and strips what owners paste: scheme, path, port, trailing dot. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * The first problem with a normalized domain, or null. `reservedHosts` are the
 * app's own hostnames; the tenant-site domain and everything under it is ours.
 */
export function domainProblem(domain: string, baseDomain: string, reservedHosts: readonly string[]): DomainProblem | null {
  if (!DOMAIN_PATTERN.test(domain) || isIP(domain) !== 0) return 'malformed';
  if (domain.split('.').length < MIN_LABELS) return 'needs_subdomain';
  const ours = [baseDomain, ...reservedHosts];
  if (ours.some((h) => domain === h || domain.endsWith(`.${h}`))) return 'reserved';
  return null;
}

/** The single CNAME target the owner points their domain at. */
export function cnameTarget(slug: string, baseDomain: string): string {
  return `${slug}.${baseDomain}`;
}

// ---------------------------------------------------------------------------
// Error states and backoff.
// ---------------------------------------------------------------------------

export const CUSTOM_DOMAIN_ERROR_MESSAGES = {
  dns_missing: "We can't find the CNAME record yet. Add it at your domain registrar; changes can take a few hours to appear.",
  dns_wrong: 'Your domain has a CNAME record, but it points somewhere else. Change it to the value shown below.',
  dns_lookup_failed: "We couldn't look up your domain just now. We'll try again shortly.",
  certificate_unavailable: "We couldn't start your secure (HTTPS) setup. We'll try again shortly.",
  certificate_failed: "Your domain points at us, but the secure (HTTPS) certificate couldn't be issued. We'll keep trying.",
  domain_taken: 'Another business has already connected this domain.',
} as const;

export type CustomDomainError = keyof typeof CUSTOM_DOMAIN_ERROR_MESSAGES;

export function customDomainErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return (CUSTOM_DOMAIN_ERROR_MESSAGES as Record<string, string>)[code] ?? 'Something went wrong checking your domain.';
}

/** Checks the sweep makes before giving up (about two and a half days at the backoff cap). */
export const CUSTOM_DOMAIN_MAX_ATTEMPTS = 60;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** Delay before the next check after `attempts` unsuccessful ones: 1m, 2m, 4m ... capped at 1h. */
export function customDomainBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// The check step.
// ---------------------------------------------------------------------------

export interface CustomDomainActor {
  userId: string;
  role: string;
}

export const SYSTEM_ACTOR: CustomDomainActor = { userId: 'system', role: 'system' };

export interface CustomDomainCheckDeps {
  baseDomain: string;
  siteRepo: TenantSiteRepository;
  settingsRepo: Pick<SettingsRepository, 'findByTenant' | 'update'>;
  auditRepo: AuditRepository;
  dns: DnsResolver;
  provider: CertificateProvider;
  now?: () => Date;
}

/** The website URL for a site: the verified connected domain, else its tenant-site address. */
export function effectiveSiteUrl(site: Pick<TenantSite, 'slug' | 'customDomain'>, baseDomain: string): string {
  return site.customDomain?.status === 'verified'
    ? `https://${site.customDomain.domain}`
    : `https://${cnameTarget(site.slug, baseDomain)}`;
}

function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\.$/, '') === b.trim().toLowerCase().replace(/\.$/, '');
}

async function audit(
  deps: CustomDomainCheckDeps,
  actor: CustomDomainActor,
  tenantId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType,
      entityType: 'tenant_site',
      entityId: tenantId,
      metadata,
    }),
  );
}

/** Once verified, the website setting follows the domain, unless the owner has a site of their own there. */
async function switchWebsiteToDomain(deps: CustomDomainCheckDeps, site: TenantSite, domain: string): Promise<boolean> {
  const settings = await deps.settingsRepo.findByTenant(site.tenantId);
  const current = settings?.websiteUrl?.trim().toLowerCase() ?? '';
  const tenantSiteUrl = `https://${cnameTarget(site.slug, deps.baseDomain)}`;
  if (current && current !== tenantSiteUrl) return false;
  await deps.settingsRepo.update(site.tenantId, { websiteUrl: `https://${domain}` });
  return true;
}

/**
 * Advances one claim by one step and records the outcome. Never throws for a
 * DNS / provider failure (those become an error state and a backoff); returns
 * the stored site, or null when the claim changed under it.
 */
export async function checkCustomDomain(
  deps: CustomDomainCheckDeps,
  site: TenantSite,
  actor: CustomDomainActor = SYSTEM_ACTOR,
): Promise<TenantSite | null> {
  const claim = site.customDomain;
  if (!claim || (claim.status !== 'pending_dns' && claim.status !== 'pending_certificate')) return site;
  const at = (deps.now ?? (() => new Date()))();
  const { tenantId } = site;
  const domain = claim.domain;

  let error: CustomDomainError | null = null;
  let status = claim.status;
  let providerRef = claim.providerRef;
  let verified = false;

  // 1. DNS: the one CNAME must name this tenant's own site address.
  let dnsOk = false;
  try {
    const targets = await deps.dns.resolveCname(domain);
    dnsOk = targets.some((t) => sameHost(t, cnameTarget(site.slug, deps.baseDomain)));
    if (!dnsOk) error = targets.length === 0 ? 'dns_missing' : 'dns_wrong';
  } catch {
    error = 'dns_lookup_failed';
  }

  // 2. HTTPS: register with the provider once DNS points at us, then wait for the certificate.
  if (dnsOk) {
    try {
      if (!providerRef) providerRef = (await deps.provider.register(domain)).ref;
      const state = await deps.provider.status(domain, providerRef);
      status = 'pending_certificate';
      if (state === 'issued') verified = true;
      else if (state === 'failed') error = 'certificate_failed';
    } catch {
      error = providerRef ? 'certificate_failed' : 'certificate_unavailable';
      status = providerRef ? 'pending_certificate' : status;
    }
  } else {
    status = 'pending_dns';
  }

  if (verified) {
    try {
      const updated = await deps.siteRepo.updateCustomDomain(tenantId, domain, {
        status: 'verified',
        error: null,
        providerRef,
        attempts: claim.attempts,
        nextCheckAt: null,
        checkedAt: at,
        verifiedAt: at,
      });
      if (!updated) return null;
      const websiteSwitched = await switchWebsiteToDomain(deps, site, domain);
      await audit(deps, actor, tenantId, 'tenant_site.domain_verified', { domain, websiteUrlSet: websiteSwitched });
      return updated;
    } catch (err) {
      if (!(err instanceof TenantSiteDomainTakenError)) throw err;
      error = 'domain_taken';
    }
  }

  const attempts = claim.attempts + 1;
  const gaveUp = attempts >= CUSTOM_DOMAIN_MAX_ATTEMPTS || error === 'domain_taken';
  const updated = await deps.siteRepo.updateCustomDomain(tenantId, domain, {
    status: gaveUp ? 'failed' : status,
    error,
    providerRef,
    attempts,
    nextCheckAt: gaveUp ? null : new Date(at.getTime() + customDomainBackoffMs(attempts)),
    checkedAt: at,
  });
  if (updated && gaveUp) {
    await audit(deps, actor, tenantId, 'tenant_site.domain_failed', { domain, error, attempts });
  }
  return updated;
}
