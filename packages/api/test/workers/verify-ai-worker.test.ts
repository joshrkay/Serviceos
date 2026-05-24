import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createVerifyAiWorker, VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

const TENANT = '11111111-1111-1111-1111-111111111111';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

interface UpdateCall {
  sql: string;
  params: unknown[];
}

/**
 * Fake pool: returns the supplied SELECT row and records every UPDATE so tests
 * can assert which verification status was persisted.
 */
function makePool(selectRow: { ai_model: string | null; ai_verification_status: string | null } | undefined) {
  const updates: UpdateCall[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: selectRow ? [selectRow] : [], rowCount: selectRow ? 1 : 0 };
      }
      updates.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as Pool;
  return { pool, updates };
}

function gatewayReturning(content: string): LLMGateway {
  return {
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content,
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 1, output: 1, total: 2 },
    })),
  } as unknown as LLMGateway;
}

function gatewayThrowing(message: string): LLMGateway {
  return {
    complete: vi.fn(async (): Promise<LLMResponse> => {
      throw new Error(message);
    }),
  } as unknown as LLMGateway;
}

function buildMessage(): QueueMessage<{ tenantId: string }> {
  return {
    id: 'msg-1',
    type: VERIFY_AI_JOB_TYPE,
    payload: { tenantId: TENANT },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `verify-ai-${TENANT}`,
    createdAt: new Date().toISOString(),
  };
}

function lastStatusWrite(updates: UpdateCall[]): string | undefined {
  const statusWrites = updates.filter((u) => /ai_verification_status\s*=/i.test(u.sql));
  const last = statusWrites[statusWrites.length - 1];
  if (!last) return undefined;
  const match = last.sql.match(/ai_verification_status\s*=\s*'([a-z]+)'/i);
  return match?.[1];
}

describe('verify-ai worker', () => {
  it('passing completion → status passed + audit event', async () => {
    const { pool, updates } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const worker = createVerifyAiWorker({ pool, gateway: gatewayReturning('pong'), auditRepo });

    await worker.handle(buildMessage(), logger);

    expect(lastStatusWrite(updates)).toBe('passed');
    const verifiedAtWrite = updates.find((u) => /ai_verified_at\s*=\s*NOW\(\)/i.test(u.sql));
    expect(verifiedAtWrite).toBeDefined();
    const events = await auditRepo.findByEntity(TENANT, 'tenant_settings', TENANT);
    expect(events.some((e) => e.eventType === 'tenant.ai_verified')).toBe(true);
  });

  it('empty completion → status failed + rethrows', async () => {
    const { pool, updates } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const worker = createVerifyAiWorker({ pool, gateway: gatewayReturning('   '), auditRepo });

    await expect(worker.handle(buildMessage(), logger)).rejects.toThrow();
    expect(lastStatusWrite(updates)).toBe('failed');
  });

  it('provider throws → status failed, error persisted, rethrows', async () => {
    const { pool, updates } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const worker = createVerifyAiWorker({ pool, gateway: gatewayThrowing('provider boom'), auditRepo });

    await expect(worker.handle(buildMessage(), logger)).rejects.toThrow('provider boom');
    expect(lastStatusWrite(updates)).toBe('failed');
    const failWrite = updates.find((u) => /ai_verification_error\s*=\s*\$1/i.test(u.sql));
    expect(failWrite?.params[0]).toBe('provider boom');
    const events = await auditRepo.findByEntity(TENANT, 'tenant_settings', TENANT);
    expect(events.some((e) => e.eventType === 'tenant.ai_verification_failed')).toBe(true);
  });

  it('already passed → idempotent skip (no gateway call, no writes)', async () => {
    const { pool, updates } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: 'passed' });
    const auditRepo = new InMemoryAuditRepository();
    const gateway = gatewayReturning('pong');
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo });

    await worker.handle(buildMessage(), logger);

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('no ai_model → failed with ai_config_missing, no gateway call', async () => {
    const { pool, updates } = makePool({ ai_model: null, ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const gateway = gatewayReturning('pong');
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo });

    await worker.handle(buildMessage(), logger);

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const missingWrite = updates.find((u) => /ai_config_missing/i.test(u.sql));
    expect(missingWrite).toBeDefined();
    expect(lastStatusWrite(updates)).toBe('failed');
  });
});
