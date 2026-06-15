import { describe, it, expect } from 'vitest';
import {
  resolveMigrationConnectionString,
  usingDedicatedMigrationRole,
} from '../../src/db/migrate-config';

describe('resolveMigrationConnectionString', () => {
  it('prefers MIGRATION_DATABASE_URL over DATABASE_URL', () => {
    expect(
      resolveMigrationConnectionString({
        MIGRATION_DATABASE_URL: 'postgres://super@host/db',
        DATABASE_URL: 'postgres://app@host/db',
      }),
    ).toBe('postgres://super@host/db');
  });

  it('falls back to DATABASE_URL when MIGRATION_DATABASE_URL is unset', () => {
    expect(
      resolveMigrationConnectionString({ DATABASE_URL: 'postgres://app@host/db' }),
    ).toBe('postgres://app@host/db');
  });

  it('falls back to DATABASE_URL when MIGRATION_DATABASE_URL is empty', () => {
    expect(
      resolveMigrationConnectionString({
        MIGRATION_DATABASE_URL: '',
        DATABASE_URL: 'postgres://app@host/db',
      }),
    ).toBe('postgres://app@host/db');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveMigrationConnectionString({})).toBeUndefined();
  });
});

describe('usingDedicatedMigrationRole', () => {
  it('is true when MIGRATION_DATABASE_URL is set and differs from DATABASE_URL', () => {
    expect(
      usingDedicatedMigrationRole({
        MIGRATION_DATABASE_URL: 'postgres://super@host/db',
        DATABASE_URL: 'postgres://app@host/db',
      }),
    ).toBe(true);
  });

  it('is false when MIGRATION_DATABASE_URL equals DATABASE_URL', () => {
    expect(
      usingDedicatedMigrationRole({
        MIGRATION_DATABASE_URL: 'postgres://app@host/db',
        DATABASE_URL: 'postgres://app@host/db',
      }),
    ).toBe(false);
  });

  it('is false when MIGRATION_DATABASE_URL is unset', () => {
    expect(usingDedicatedMigrationRole({ DATABASE_URL: 'postgres://app@host/db' })).toBe(false);
  });
});
