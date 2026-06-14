/**
 * Canonical UUID guard shared across HTTP routes and resolvers.
 *
 * Several call sites take an id straight from a URL param or a free-text
 * reference and pass it into a tenant-scoped query (or `set_config` /
 * `setTenantContext`). Postgres will throw `invalid input syntax for type
 * uuid` on a malformed value, which surfaces as a 500 (and, on the pooled
 * resolver path, after a connection has already been checked out). Validating
 * up front lets the caller fail closed with a clean 400 / skip instead.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
