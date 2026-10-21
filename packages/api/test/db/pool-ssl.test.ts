/**
 * Hardening sweep 2026-10 (audit T4-F13) — Postgres TLS settings.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPgSsl, resetPgSslWarningForTests } from '../../src/db/pool';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

describe('buildPgSsl', () => {
  beforeEach(() => resetPgSslWarningForTests());

  it('DB_SSL=false disables TLS entirely (local Postgres / testcontainers)', () => {
    const warn = vi.fn();
    expect(buildPgSsl({ DB_SSL: 'false', DB_SSL_CA: CA }, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('DB_SSL_CA turns certificate verification ON with that CA', () => {
    const warn = vi.fn();
    expect(buildPgSsl({ DB_SSL_CA: CA }, warn)).toEqual({ rejectUnauthorized: true, ca: CA });
    expect(warn).not.toHaveBeenCalled();
  });

  it('unescapes \\n sequences the way Railway stores multi-line variables', () => {
    const escaped = CA.replace(/\n/g, '\\n');
    expect(buildPgSsl({ DB_SSL_CA: escaped }, vi.fn())).toEqual({ rejectUnauthorized: true, ca: CA });
  });

  it('without a CA keeps the historic unverified TLS and warns exactly once', () => {
    const warn = vi.fn();
    expect(buildPgSsl({}, warn)).toEqual({ rejectUnauthorized: false });
    expect(buildPgSsl({ DB_SSL_CA: '   ' }, warn)).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DB_SSL_CA/);
  });
});
