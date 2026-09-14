import type { RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { toErrorResponse } from '../shared/errors';
import { captureServerError } from '../monitoring/capture-server-error';

/**
 * Wraps async Express handlers so route files do not repeat try/catch + toErrorResponse.
 * Errors are mapped inline and never reach the global error handler, so a
 * 5xx mapping is captured to Sentry here (R1); 4xx never captures.
 */
export function asyncRoute(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req as AuthenticatedRequest, res)).catch((err: unknown) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const { statusCode, body } = toErrorResponse(err);
      if (statusCode >= 500) captureServerError(err, req);
      res.status(statusCode).json(body);
    });
  };
}
