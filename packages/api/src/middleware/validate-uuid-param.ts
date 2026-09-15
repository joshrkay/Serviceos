/**
 * #882 — shared malformed-:id guard.
 *
 * Every Pg repository compares `:id` route params against a `uuid` column, so
 * a non-UUID id (`/api/jobs/new`, a truncated paste, a scanner probe) used to
 * surface Postgres's `invalid input syntax for type uuid` as an unclassified
 * bare 500. A malformed id can never name a resource, so the route's own
 * not-found envelope is the right answer — 404, per the #871 customers
 * precedent (`{ error: 'NOT_FOUND', message }`), and it avoids leaking the id
 * format. (interactions.ts / users.ts / entity-aliases.ts predate that
 * convention and answer 400; reconciling them is out of #882's scope.)
 *
 * Insert AFTER requirePermission/requireRole in each route's chain so auth
 * ordering is preserved (401/403 must answer before any existence signal).
 * Never wire this via `router.param` — param callbacks run before the
 * per-route middleware stack, which would leak 404s to unauthenticated
 * callers that today correctly get 401.
 */
import { NextFunction, Request, Response } from 'express';
import { uuidSchema } from '../shared/validation';

export const notFoundOnMalformedId =
  (message: string, param = 'id') =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (uuidSchema.safeParse(req.params[param]).success) {
      next();
      return;
    }
    res.status(404).json({ error: 'NOT_FOUND', message });
  };
