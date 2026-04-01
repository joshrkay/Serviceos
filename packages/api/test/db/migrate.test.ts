import { applyPendingMigrations } from '../../src/db/migrate';

interface FakeClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
}

function createFakePool(initialApplied: string[]) {
  const applied = new Set(initialApplied);
  const executedQueries: string[] = [];
  const transactions: string[][] = [];

  const pool = {
    query: vi.fn(async (text: string) => {
      executedQueries.push(text);

      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        return { rows: [] };
      }

      if (text.startsWith('SELECT migration_key FROM schema_migrations')) {
        return {
          rows: Array.from(applied).map((migrationKey) => ({ migration_key: migrationKey })),
        };
      }

      throw new Error(`Unexpected pool query: ${text}`);
    }),
    connect: vi.fn(async () => {
      const txQueries: string[] = [];
      transactions.push(txQueries);

      const client: FakeClient = {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          txQueries.push(text);

          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [] };
          }

          if (text.startsWith('INSERT INTO schema_migrations')) {
            const migrationKey = params?.[0];
            if (typeof migrationKey === 'string') {
              applied.add(migrationKey);
            }
            return { rows: [] };
          }

          return { rows: [] };
        }),
        release: vi.fn(),
      };

      return client;
    }),
    end: vi.fn(async () => {}),
  };

  return {
    applied,
    executedQueries,
    pool,
    transactions,
  };
}

describe('db migration runner', () => {
  const TEST_MIGRATIONS = {
    '001_first': 'CREATE TABLE IF NOT EXISTS first_table (id INT);',
    '002_second': 'CREATE TABLE IF NOT EXISTS second_table (id INT);',
  };

  it('applies pending migrations and records keys', async () => {
    const fake = createFakePool([]);

    const applied = await applyPendingMigrations(fake.pool, TEST_MIGRATIONS);

    expect(applied).toEqual(['001_first', '002_second']);
    expect(fake.applied).toEqual(new Set(['001_first', '002_second']));
    expect(fake.pool.connect).toHaveBeenCalledTimes(2);
    expect(fake.transactions[0]).toEqual([
      'BEGIN',
      'CREATE TABLE IF NOT EXISTS first_table (id INT);',
      'INSERT INTO schema_migrations (migration_key) VALUES ($1) ON CONFLICT (migration_key) DO NOTHING',
      'COMMIT',
    ]);
    expect(fake.transactions[1]).toEqual([
      'BEGIN',
      'CREATE TABLE IF NOT EXISTS second_table (id INT);',
      'INSERT INTO schema_migrations (migration_key) VALUES ($1) ON CONFLICT (migration_key) DO NOTHING',
      'COMMIT',
    ]);
  });

  it('is idempotent on re-run when migrations are already recorded', async () => {
    const fake = createFakePool(['001_first', '002_second']);

    const applied = await applyPendingMigrations(fake.pool, TEST_MIGRATIONS);

    expect(applied).toEqual([]);
    expect(fake.pool.connect).not.toHaveBeenCalled();
    expect(fake.executedQueries).toHaveLength(2);
    expect(fake.executedQueries[0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(fake.executedQueries[1]).toBe('SELECT migration_key FROM schema_migrations ORDER BY migration_key ASC');
  });
});
