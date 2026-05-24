import { describe, it, expect } from 'vitest';
import {
  narrowLanguage,
  resolveCustomerLanguage,
} from '../../src/i18n/resolve-language';

describe('narrowLanguage', () => {
  it('passes through supported languages', () => {
    expect(narrowLanguage('en')).toBe('en');
    expect(narrowLanguage('es')).toBe('es');
  });

  it('maps region-tagged BCP-47 tags to their base language (case-insensitive)', () => {
    expect(narrowLanguage('es-MX')).toBe('es');
    expect(narrowLanguage('en-US')).toBe('en');
    expect(narrowLanguage('ES')).toBe('es');
    expect(narrowLanguage(' en-GB ')).toBe('en');
  });

  it('returns null for unsupported / empty values', () => {
    expect(narrowLanguage('vi')).toBeNull();
    expect(narrowLanguage('fr-FR')).toBeNull();
    expect(narrowLanguage('')).toBeNull();
    expect(narrowLanguage(null)).toBeNull();
    expect(narrowLanguage(undefined)).toBeNull();
  });
});

describe('resolveCustomerLanguage', () => {
  it('prefers the customer preference over the tenant default', () => {
    expect(
      resolveCustomerLanguage({
        customerPreferredLanguage: 'es',
        tenantDefaultLanguage: 'en',
      }),
    ).toBe('es');
  });

  it('falls back to the tenant default when no customer preference', () => {
    expect(
      resolveCustomerLanguage({
        customerPreferredLanguage: null,
        tenantDefaultLanguage: 'es',
      }),
    ).toBe('es');
  });

  it('ignores an unsupported customer preference and uses tenant default', () => {
    expect(
      resolveCustomerLanguage({
        customerPreferredLanguage: 'vi',
        tenantDefaultLanguage: 'es',
      }),
    ).toBe('es');
  });

  it('defaults to en when nothing is configured', () => {
    expect(resolveCustomerLanguage({})).toBe('en');
  });

  it('honors a region-tagged customer preference over the tenant default', () => {
    expect(
      resolveCustomerLanguage({
        customerPreferredLanguage: 'es-MX',
        tenantDefaultLanguage: 'en',
      }),
    ).toBe('es');
  });
});
