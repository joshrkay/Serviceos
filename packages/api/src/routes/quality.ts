import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError } from '../shared/errors';
import {
  QualityMetricsRepository,
  evaluateBetaReadiness,
} from '../quality/metrics';
import { VerticalType, isValidVerticalType } from '../shared/vertical-types';
import { ApprovalRepository } from '../estimates/approval';
import { EditDeltaRepository } from '../estimates/edit-delta';
import {
  ComputeQualityOptions,
  computeVerticalQualityMetrics,
} from '../estimates/vertical-quality-metrics';
import { computeAccelerationBenchmark } from '../estimates/acceleration-benchmark';

export interface QualityRouterDeps {
  metricsRepo: QualityMetricsRepository;
  approvalRepo: ApprovalRepository;
  deltaRepo: EditDeltaRepository;
}

interface VerticalAnalyticsFilters extends ComputeQualityOptions {
  verticalType: VerticalType;
}

function parseVerticalAnalyticsFilters(req: AuthenticatedRequest): VerticalAnalyticsFilters {
  const { verticalType } = req.params;

  if (!isValidVerticalType(verticalType)) {
    throw new ValidationError('Validation failed', {
      issues: [{ path: 'verticalType', message: 'Invalid verticalType' }],
    });
  }

  const parseOptionalDate = (value: unknown, field: string): Date | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value as string);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('Validation failed', {
        issues: [{ path: field, message: `Invalid ${field}` }],
      });
    }
    return parsed;
  };

  return {
    verticalType,
    serviceCategory: req.query.serviceCategory as ComputeQualityOptions['serviceCategory'] | undefined,
    promptVersion: req.query.promptVersion as string | undefined,
    periodStart: parseOptionalDate(req.query.periodStart, 'periodStart'),
    periodEnd: parseOptionalDate(req.query.periodEnd, 'periodEnd'),
  };
}

async function findFilteredEstimateIds(
  tenantId: string,
  approvalRepo: ApprovalRepository,
  filters: VerticalAnalyticsFilters
): Promise<string[]> {
  const approvals = await approvalRepo.findByTenant(tenantId);

  return approvals
    .filter((approval) => {
      const metadata = approval.metadata ?? {};
      const metadataVertical = metadata.verticalType;
      const metadataServiceCategory = metadata.serviceCategory;
      const metadataPromptVersion = metadata.promptVersion;

      if (metadataVertical !== filters.verticalType) return false;
      if (filters.serviceCategory && metadataServiceCategory !== filters.serviceCategory) return false;
      if (filters.promptVersion && metadataPromptVersion !== filters.promptVersion) return false;

      const eventDate = approval.approvedAt ?? approval.rejectedAt ?? approval.createdAt;
      if (filters.periodStart && eventDate < filters.periodStart) return false;
      if (filters.periodEnd && eventDate > filters.periodEnd) return false;

      return true;
    })
    .map((approval) => approval.estimateId);
}

export function createQualityRouter({ metricsRepo, approvalRepo, deltaRepo }: QualityRouterDeps): Router {
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

  // Vertical-aware quality metrics endpoint
  router.get(
    '/vertical/:verticalType/metrics',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const filters = parseVerticalAnalyticsFilters(req);
        const estimateIds = await findFilteredEstimateIds(req.auth!.tenantId, approvalRepo, filters);

        const metrics = await computeVerticalQualityMetrics(
          req.auth!.tenantId,
          filters.verticalType,
          approvalRepo,
          deltaRepo,
          estimateIds,
          {
            serviceCategory: filters.serviceCategory,
            promptVersion: filters.promptVersion,
            periodStart: filters.periodStart,
            periodEnd: filters.periodEnd,
          }
        );

        res.json({
          hasData: metrics.sampleSize > 0,
          message:
            metrics.sampleSize > 0
              ? 'Metrics computed successfully'
              : 'No estimate analytics data found for the requested filters',
          metrics,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Vertical-aware acceleration benchmark endpoint
  router.get(
    '/vertical/:verticalType/benchmark',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const filters = parseVerticalAnalyticsFilters(req);
        const estimateIds = await findFilteredEstimateIds(req.auth!.tenantId, approvalRepo, filters);

        const metrics = await computeVerticalQualityMetrics(
          req.auth!.tenantId,
          filters.verticalType,
          approvalRepo,
          deltaRepo,
          estimateIds,
          {
            serviceCategory: filters.serviceCategory,
            promptVersion: filters.promptVersion,
            periodStart: filters.periodStart,
            periodEnd: filters.periodEnd,
          }
        );

        const manualEstimateTimeMs = req.query.manualEstimateTimeMs
          ? Number(req.query.manualEstimateTimeMs)
          : undefined;
        const aiAssistedEstimateTimeMs = req.query.aiAssistedEstimateTimeMs
          ? Number(req.query.aiAssistedEstimateTimeMs)
          : undefined;

        const benchmark = computeAccelerationBenchmark(req.auth!.tenantId, filters.verticalType, metrics, {
          manualEstimateTimeMs,
          aiAssistedEstimateTimeMs,
        });

        res.json({
          hasData: benchmark.sampleSize > 0,
          message:
            benchmark.sampleSize > 0
              ? 'Benchmark computed successfully'
              : 'No estimate analytics data found for the requested filters',
          benchmark,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
