/**
 * Hardening sweep 2026-10 (audit T4-F13) — Postgres TLS settings.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPgSsl, prepareDsn, resetPgSslWarningForTests } from '../../src/db/pool';

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

describe('prepareDsn — the DSN cannot override buildPgSsl() (Codex review, #1744)', () => {
  // pg merges parse(connectionString) OVER the config object, so a stray
  // `?sslmode=require` would replace a verified `ssl` with
  // `{ rejectUnauthorized: false }`, and `?sslmode=disable` would make it
  // plaintext. Every ssl key is stripped at the source; only DB_SSL / DB_SSL_CA
  // decide.
  it('leaves a DSN without a query string untouched', () => {
    expect(prepareDsn('postgres://u:p@db.internal:5432/app')).toBe('postgres://u:p@db.internal:5432/app');
  });

  it.each([
    'sslmode=require',
    'sslmode=no-verify',
    'sslmode=verify-full&sslrootcert=/tmp/ca.pem',
    'sslcert=/tmp/c.pem&sslkey=/tmp/k.pem',
    'ssl=true',
    'ssl=1',
    'sslmode=disable',
    'ssl=0',
  ])('strips %s so TLS stays governed by DB_SSL / DB_SSL_CA', (query) => {
    expect(prepareDsn(`postgres://u:p@db.internal:5432/app?${query}`)).toBe(
      'postgres://u:p@db.internal:5432/app',
    );
  });

  it('keeps unrelated query parameters (PgBouncer / socket options)', () => {
    expect(
      prepareDsn('postgres://u:p@db.internal:6432/app?sslmode=require&application_name=api&pgbouncer=true'),
    ).toBe('postgres://u:p@db.internal:6432/app?application_name=api&pgbouncer=true');
  });

  it('a DSN sslmode=disable cannot downgrade a deployment that set DB_SSL_CA', () => {
    const dsn = prepareDsn('postgres://u:p@db.internal:5432/app?sslmode=disable');
    expect(dsn).not.toMatch(/ssl/);
    expect(buildPgSsl({ DB_SSL_CA: CA }, vi.fn())).toEqual({ rejectUnauthorized: true, ca: CA });
  });
});
