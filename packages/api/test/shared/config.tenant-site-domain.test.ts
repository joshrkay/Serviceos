/**
 * D-044 / #1768 — TENANT_SITE_BASE_DOMAIN: the separate domain tenant sites
 * are served on. Unset turns the feature off; a malformed value or one that
 * contains the app/API host fails boot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';

const BASE = { NODE_ENV: 'dev', WEB_URL: 'https://app.example.com', PUBLIC_API_URL: 'https://api.example.com' };

describe('TENANT_SITE_BASE_DOMAIN', () => {
  beforeEach(() => resetConfig());

  it('is undefined (feature off) when unset', () => {
    expect(loadConfig(BASE).TENANT_SITE_BASE_DOMAIN).toBeUndefined();
  });

  it('treats an empty value as unset', () => {
    expect(loadConfig({ ...BASE, TENANT_SITE_BASE_DOMAIN: '' }).TENANT_SITE_BASE_DOMAIN).toBeUndefined();
  });

  it('normalizes to a lowercase hostname', () => {
    expect(loadConfig({ ...BASE, TENANT_SITE_BASE_DOMAIN: ' Sites.Example-Pages.com ' }).TENANT_SITE_BASE_DOMAIN).toBe(
      'sites.example-pages.com',
    );
  });

  it.each(['https://sites.example-pages.com', 'sites.example-pages.com:8080', 'sites.example-pages.com/x', 'localhost', '*.example.com'])(
    'refuses %s',
    (value) => {
      expect(() => loadConfig({ ...BASE, TENANT_SITE_BASE_DOMAIN: value })).toThrow(/TENANT_SITE_BASE_DOMAIN/);
    },
  );

  it('refuses the app domain, a parent of it, or the API host', () => {
    expect(() => loadConfig({ ...BASE, TENANT_SITE_BASE_DOMAIN: 'app.example.com' })).toThrow(/separate domain/);
    resetConfig();
    expect(() => loadConfig({ ...BASE, TENANT_SITE_BASE_DOMAIN: 'example.com' })).toThrow(/separate domain/);
  });
});
