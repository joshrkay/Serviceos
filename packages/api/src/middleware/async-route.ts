import type { RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { toErrorResponse } from '../shared/errors';

/**
 * Wraps async Express handlers so route files do not repeat try/catch + toErrorResponse.
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
      res.status(statusCode).json(body);
    });
  };
}
