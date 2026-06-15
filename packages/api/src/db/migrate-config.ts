/**
 * Connection-string resolution for the migration runner.
 *
 * The migration set requires a privileged Postgres role:
 *   - it runs `CREATE EXTENSION vector` (pgvector is NOT a "trusted"
 *     extension, so only a superuser may create it), and
 *   - it runs data-fixup statements against tables with FORCE ROW LEVEL
 *     SECURITY, which a non-superuser/non-BYPASSRLS role cannot execute
 *     (the RLS policy reads the unset `app.current_tenant_id` GUC).
 *
 * On managed Postgres the app's runtime role is often NOT a superuser, so
 * migrations should run under an elevated connection. `MIGRATION_DATABASE_URL`
 * lets the deploy point the migrate step at a superuser/owner connection while
 * the app keeps using its least-privilege `DATABASE_URL` at runtime. When it is
 * not set, we fall back to `DATABASE_URL` (unchanged behavior).
 */
export function resolveMigrationConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.MIGRATION_DATABASE_URL || env.DATABASE_URL || undefined;
}

/**
 * True when migrations will run under a dedicated, distinct connection from the
 * app runtime — used only for an informational startup log.
 */
export function usingDedicatedMigrationRole(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MIGRATION_DATABASE_URL && env.MIGRATION_DATABASE_URL !== env.DATABASE_URL);
}
