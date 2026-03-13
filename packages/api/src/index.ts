import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { loadConfig } from './shared/config';
import { createLogger } from './logging/logger';
import { createHealthRouter } from './health/health';
import { clerkAuthMiddleware, extractAuthContext } from './auth/clerk';
import { correlationIdHeader } from './shared/contracts';
import { createWebhookRouter } from './webhooks/routes';

const config = loadConfig();
const logger = createLogger({ service: 'api', environment: config.NODE_ENV, level: config.LOG_LEVEL });

const app = express();

// ── Core middleware ───────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Correlation ID — attach to every request for distributed tracing
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId =
    (req.headers[correlationIdHeader] as string) || randomUUID();
  res.setHeader(correlationIdHeader, correlationId);
  (req as Request & { correlationId: string }).correlationId = correlationId;
  next();
});

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info('incoming request', {
    method: req.method,
    path: req.path,
    correlationId: (req as Request & { correlationId?: string }).correlationId,
  });
  next();
});

// ── Unauthenticated routes (before Clerk middleware) ─────────────────────────

// Health check — no auth, used by ALB target group and uptime monitors
app.use(createHealthRouter('0.1.0', config.NODE_ENV));

// Webhooks — auth is handled by signature verification, not Clerk JWTs
app.use('/webhooks', createWebhookRouter(config));

// ── Clerk auth — all routes below require a valid JWT ────────────────────────
app.use(clerkAuthMiddleware);
app.use(extractAuthContext);

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const correlationId = (req as Request & { correlationId?: string }).correlationId;
  logger.error('unhandled error', {
    error: err.message,
    stack: err.stack,
    correlationId,
  });
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected error occurred',
  });
});

// ── Start server ──────────────────────────────────────────────────────────────

const port = config.PORT;
app.listen(port, () => {
  logger.info(`ServiceOS API listening on port ${port}`, {
    environment: config.NODE_ENV,
    port,
  });
});

export default app;
