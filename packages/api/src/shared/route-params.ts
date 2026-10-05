/**
 * Typed read of a route parameter (#1555, Express 5).
 *
 * @types/express 5 types every `req.params` value as `string | string[]`:
 * a named `:param` is always a string at runtime, but a `*splat` wildcard
 * is the array of path segments it matched. Handlers read params through
 * this helper instead of casting, so the one place that decides how an
 * array param becomes a string is here: segments are rejoined with '/',
 * which is the path the wildcard matched (Express 4's `req.params[0]`).
 * A param the route does not define reads as '' (falsy, like the old
 * `undefined`, but honestly typed as `string`).
 */
export function routeParam(req: { params: unknown }, name: string): string {
  const params = req.params as Record<string, string | string[] | undefined> | undefined;
  const value = params?.[name];
  if (Array.isArray(value)) return value.join('/');
  return value ?? '';
}
