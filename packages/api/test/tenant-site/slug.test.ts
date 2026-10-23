/**
 * D-044 / #1768 — tenant site addresses: malformed, reserved and host parsing.
 */
import { describe, expect, it } from 'vitest';
import { matchTenantSiteHost, normalizeSlug, slugProblem, suggestSlug } from '../../src/tenant-site/slug';

describe('slugProblem', () => {
  it.each(['joes-plumbing', 'abc', 'a1b', 'acme-hvac-2'])('accepts %s', (slug) => {
    expect(slugProblem(slug)).toBeNull();
  });

  it('flags length', () => {
    expect(slugProblem('ab')).toBe('too_short');
    expect(slugProblem('a'.repeat(43))).toBe('too_long');
    expect(slugProblem('a'.repeat(42))).toBeNull();
  });

  it.each(['-joes', 'joes-', 'jo es', 'Joes', 'joes_plumbing', 'joes.plumbing', 'a--b', 'joé-s', 'jo/es'])(
    'flags %s as malformed',
    (slug) => {
      expect(slugProblem(slug)).toBe('malformed');
    },
  );

  it.each(['www', 'app', 'api', 'admin', 'mail', 'login', 'billing', 'support'])('reserves %s', (slug) => {
    expect(slugProblem(slug)).toBe('reserved');
  });
});

describe('normalizeSlug', () => {
  it('lowercases and trims what the owner typed', () => {
    expect(normalizeSlug('  Joes-Plumbing ')).toBe('joes-plumbing');
  });
});

describe('suggestSlug', () => {
  it('builds an address from the business name', () => {
    expect(suggestSlug("Joe's Plumbing & Heating")).toBe('joes-plumbing-heating');
    expect(suggestSlug('Café Frío HVAC')).toBe('cafe-frio-hvac');
  });

  it('suggests nothing when the name yields no usable address', () => {
    expect(suggestSlug('')).toBe('');
    expect(suggestSlug('!!')).toBe('');
    expect(suggestSlug('Admin')).toBe('');
  });

  it('trims to the maximum length without a trailing hyphen', () => {
    const slug = suggestSlug(`${'a'.repeat(41)} bee`);
    expect(slug.length).toBeLessThanOrEqual(42);
    expect(slug.endsWith('-')).toBe(false);
    expect(slugProblem(slug)).toBeNull();
  });
});

describe('matchTenantSiteHost', () => {
  const BASE = 'sites.example.com';

  it('reads the slug from a single subdomain, in any case', () => {
    expect(matchTenantSiteHost('joes-plumbing.sites.example.com', BASE)).toEqual({ kind: 'site', slug: 'joes-plumbing' });
    expect(matchTenantSiteHost('Joes-Plumbing.Sites.Example.com.', BASE)).toEqual({ kind: 'site', slug: 'joes-plumbing' });
  });

  it('leaves every other host to the app', () => {
    expect(matchTenantSiteHost('app.example.com', BASE)).toEqual({ kind: 'other' });
    expect(matchTenantSiteHost('example.com', BASE)).toEqual({ kind: 'other' });
    expect(matchTenantSiteHost('evilsites.example.com', BASE)).toEqual({ kind: 'other' });
    expect(matchTenantSiteHost('sites.example.com.evil.test', BASE)).toEqual({ kind: 'other' });
    expect(matchTenantSiteHost('', BASE)).toEqual({ kind: 'other' });
  });

  it('the base domain itself, nested subdomains and reserved names serve no site', () => {
    expect(matchTenantSiteHost('sites.example.com', BASE)).toEqual({ kind: 'unknown' });
    expect(matchTenantSiteHost('a.b.sites.example.com', BASE)).toEqual({ kind: 'unknown' });
    expect(matchTenantSiteHost('www.sites.example.com', BASE)).toEqual({ kind: 'unknown' });
    expect(matchTenantSiteHost('-x-.sites.example.com', BASE)).toEqual({ kind: 'unknown' });
  });
});
