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

    res.status(overallStatus === 'down' ? 503 : 200).json(response);
  });

  router.get('/ready', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ready' });
  });

  return router;
}
