import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import {
  QualityMetricsRepository,
  evaluateBetaReadiness,
} from '../quality/metrics';

export function createQualityRouter(metricsRepo: QualityMetricsRepository): Router {
  const router = Router();

  // Get latest quality metrics
  router.get(
    '/metrics',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const metrics = await metricsRepo.getLatestMetrics(req.auth!.tenantId);
        if (!metrics) {
          res.json({ message: 'No metrics available yet' });
          return;
        }
        res.json(metrics);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get beta readiness assessment
  router.get(
    '/beta-readiness',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const metrics = await metricsRepo.getLatestMetrics(req.auth!.tenantId);
        if (!metrics) {
          res.json({
            isReady: false,
            message: 'Insufficient data — no quality metrics recorded yet',
            checks: [],
            overallScore: 0,
          });
          return;
        }
        const readiness = evaluateBetaReadiness(metrics);
        res.json(readiness);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get metric time series
  router.get(
    '/metrics/:metricName',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const startDate = req.query.startDate
          ? new Date(req.query.startDate as string)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default 30 days
        const endDate = req.query.endDate
          ? new Date(req.query.endDate as string)
          : new Date();

        const series = await metricsRepo.getMetricTimeSeries(
          req.auth!.tenantId,
          req.params.metricName,
          startDate,
          endDate
        );
        res.json(series);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
