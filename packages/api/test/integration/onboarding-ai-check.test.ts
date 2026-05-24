import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createVerifyAiWorker, VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
import { createMockLLMGateway } from '../../src/ai/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue, QueueMessage } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function message(tenantId: string): QueueMessage<{ tenantId: string }> {
  return {
    id: 'msg-1',
    type: VERIFY_AI_JOB_TYPE,
    payload: { tenantId },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `verify-ai-${tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

async function seedSettings(pool: Pool, tenantId: string, aiModel: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, ai_model, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
     VALUES (gen_random_uuid(), $1, 'Acme', $2, 'America/New_York', 'EST', 'INV', 1, 1, 30)
     ON CONFLICT (tenant_id) DO UPDATE SET ai_model = EXCLUDED.ai_model`,
    [tenantId, aiModel],
  );
}

describe('onboarding AI self-check', () => {
  let pool: Pool;
  let app: express.Express;
  let queue: InMemoryQueue;
  let currentTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    queue = new InMemoryQueue();

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: currentTenant.userId,
        sessionId: 'sess-test',
        tenantId: currentTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/onboarding', createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool, queue }));
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('passing verification → ai_check step done and DB status passed', async () => {
    await seedSettings(pool, currentTenant.tenantId, 'gpt-4o-mini');
    const { gateway } = createMockLLMGateway('pong');
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo: new InMemoryAuditRepository() });

    await worker.handle(message(currentTenant.tenantId), logger);

    const status = await request(app).get('/api/onboarding/status');
    const aiStep = status.body.steps.find((s: { id: string }) => s.id === 'ai_check');
    expect(aiStep.status).toBe('done');

    const row = await pool.query(
      `SELECT ai_verification_status, ai_verified_at FROM tenant_settings WHERE tenant_id = $1`,
      [currentTenant.tenantId],
    );
    expect(row.rows[0].ai_verification_status).toBe('passed');
    expect(row.rows[0].ai_verified_at).not.toBeNull();
  });

  it('failing verification → ai_check step error with ai_verification_failed blocker', async () => {
    await seedSettings(pool, currentTenant.tenantId, 'gpt-4o-mini');
    const throwingGateway = {
      complete: async (): Promise<LLMResponse> => {
        throw new Error('provider down');
      },
    } as unknown as LLMGateway;
    const worker = createVerifyAiWorker({ pool, gateway: throwingGateway, auditRepo: new InMemoryAuditRepository() });

    await expect(worker.handle(message(currentTenant.tenantId), logger)).rejects.toThrow();

    const status = await request(app).get('/api/onboarding/status');
    const aiStep = status.body.steps.find((s: { id: string }) => s.id === 'ai_check');
    expect(aiStep.status).toBe('error');
    expect(aiStep.blockers).toEqual(['ai_verification_failed']);
  });

  it('retry route resets status to pending and enqueues a verify_ai job', async () => {
    await seedSettings(pool, currentTenant.tenantId, 'gpt-4o-mini');
    await pool.query(
      `UPDATE tenant_settings SET ai_verification_status = 'failed', ai_verification_error = 'boom' WHERE tenant_id = $1`,
      [currentTenant.tenantId],
    );

    const before = queue.size();
    const res = await request(app).post('/api/onboarding/ai-check/retry').send({});
    expect(res.status).toBe(200);
    expect(res.body.enqueued).toBe(true);
    expect(queue.size()).toBe(before + 1);

    const row = await pool.query(
      `SELECT ai_verification_status, ai_verification_error FROM tenant_settings WHERE tenant_id = $1`,
      [currentTenant.tenantId],
    );
    expect(row.rows[0].ai_verification_status).toBe('pending');
    expect(row.rows[0].ai_verification_error).toBeNull();
  });
});
