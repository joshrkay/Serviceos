import { Request, Response, Router } from 'express';
import { HealthResponse } from '../shared/contracts';

export interface HealthCheck {
  name: string;
  check: () => Promise<{ status: 'ok' | 'degraded' | 'down'; message?: string }>;
}

export function createHealthRouter(
  version: string,
  environment: string,
  checks: HealthCheck[] = []
): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    const checkResults: Record<string, { status: 'ok' | 'degraded' | 'down'; message?: string }> = {};
    let overallStatus: 'ok' | 'degraded' | 'down' = 'ok';

    for (const hc of checks) {
      try {
        checkResults[hc.name] = await hc.check();
        if (checkResults[hc.name].status === 'down') {
          overallStatus = 'down';
        } else if (checkResults[hc.name].status === 'degraded' && overallStatus === 'ok') {
          overallStatus = 'degraded';
        }
      } catch (err) {
        checkResults[hc.name] = { status: 'down', message: 'Check failed' };
        overallStatus = 'down';
      }
    }

    const response: HealthResponse = {
      status: overallStatus,
      version,
      environment,
      timestamp: new Date().toISOString(),
      ...(Object.keys(checkResults).length > 0 ? { checks: checkResults } : {}),
    };

    // Always return 200 for liveness — platform healthchecks (Railway) use /health
    // to decide if the deploy succeeded. Dependency failures (DB, cache) should
    // degrade gracefully, not block deploys. Use /ready for readiness gating.
    res.status(200).json(response);
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    // Readiness probe — returns 503 when a critical dependency is down.
    let ready = true;
    for (const hc of checks) {
      try {
        const result = await hc.check();
        if (result.status === 'down') { ready = false; break; }
      } catch {
        ready = false;
        break;
      }
    }
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  return router;
}
