import { describe, it, expect, vi } from 'vitest';
import { createVerifyAiWorker, VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';
import type { SentryClient } from '../../src/monitoring/sentry';
import { currentTenantContext } from '../../src/middleware/tenant-context';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '11111111-1111-1111-1111-111111111111';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** Sentry spy: records each withScope capture (tags + error) for assertions. */
function makeSentrySpy() {
  const events: { tags: Record<string, string>; error: Error | null }[] = [];
  const sentry = {
    withScope(cb: (scope: { setTag(key: string, value: string): void; captureException(error: Error): string }) => void) {
      const tags: Record<string, string> = {};
      let error: Error | null = null;
      cb({
        setTag: (key, value) => {
          tags[key] = value;
        },
        captureException: (e) => {
          error = e;
          return 'spy';
        },
      });
      events.push({ tags, error });
    },
  } as unknown as SentryClient;
  return { sentry, events };
}

interface UpdateCall {
  sql: string;
  params: unknown[];
}

/** Transaction control and the tenant context statement: a session's frame, not its work. */
const SESSION = /^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config\()/;

/**
 * Fake tenant pool (test/helpers/fake-tenant-pool.ts): returns the supplied
 * tenant_settings row and records every UPDATE so tests can assert which
 * verification status was persisted, and on which tenant session.
 */
function makePool(selectRow: { ai_model: string | null; ai_verification_status: string | null } | undefined) {
  const updates: UpdateCall[] = [];
  const fake = fakeTenantPool((sql, params = []) => {
    if (SESSION.test(sql)) return undefined;
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: selectRow ? [selectRow] : [], rowCount: selectRow ? 1 : 0 };
    }
    updates.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  return { pool: fake.pool, updates, fake };
}

/** [checkout, verb] per statement, the tenant context statement read as CONTEXT. */
function ran(fake: ReturnType<typeof makePool>['fake']): Array<[number, string]> {
  return fake.statements.map((st) => {
    if (/set_config\('app\.current_tenant_id'/.test(st.sql)) return [st.checkout, 'CONTEXT'];
    const status = st.sql.match(/ai_verification_status\s*=\s*'([a-z]+)'/i)?.[1];
    const verb = st.sql.trim().split(/\s+/)[0]!;
    return [st.checkout, status ? `${verb} ${status}` : verb];
  });
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

  it('provider throws → failure reported to Sentry with tenant, step, reason', async () => {
    const { pool } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const { sentry, events } = makeSentrySpy();
    const worker = createVerifyAiWorker({
      pool,
      gateway: gatewayThrowing('provider boom'),
      auditRepo,
      sentry,
    });

    await expect(worker.handle(buildMessage(), logger)).rejects.toThrow('provider boom');

    expect(events).toHaveLength(1);
    expect(events[0].tags.tenant_id).toBe(TENANT);
    expect(events[0].tags.step).toBe('ai_check');
    expect(events[0].tags.failure_reason).toContain('provider boom');
    expect(events[0].error?.message).toContain('provider boom');
  });

  it('no ai_model → failure reported to Sentry with ai_config_missing reason', async () => {
    const { pool } = makePool({ ai_model: null, ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const { sentry, events } = makeSentrySpy();
    const worker = createVerifyAiWorker({
      pool,
      gateway: gatewayReturning('pong'),
      auditRepo,
      sentry,
    });

    await worker.handle(buildMessage(), logger);

    expect(events).toHaveLength(1);
    expect(events[0].tags.tenant_id).toBe(TENANT);
    expect(events[0].tags.step).toBe('ai_check');
    expect(events[0].tags.failure_reason).toBe('ai_config_missing');
  });

  it('pass → nothing reported to Sentry', async () => {
    const { pool } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    const auditRepo = new InMemoryAuditRepository();
    const { sentry, events } = makeSentrySpy();
    const worker = createVerifyAiWorker({ pool, gateway: gatewayReturning('pong'), auditRepo, sentry });

    await worker.handle(buildMessage(), logger);

    expect(events).toHaveLength(0);
  });
});

describe('verify-ai worker — tenant sessions (raw-pg audit 2026-10-23 §4 P1.9)', () => {
  it('stage 1 reads the row and marks it running in ONE tenant session, committed and released before the gateway call', async () => {
    const { pool, fake } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    let atCall: { open: number; ran: Array<[number, string]>; context: unknown } | undefined;
    const gateway = {
      complete: vi.fn(async (): Promise<LLMResponse> => {
        atCall = { open: fake.open(), ran: ran(fake), context: currentTenantContext() };
        return { content: 'pong', model: 'mock-model', provider: 'mock', latencyMs: 1, tokenUsage: { input: 1, output: 1, total: 2 } };
      }),
    } as unknown as LLMGateway;
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo: new InMemoryAuditRepository() });

    await worker.handle(buildMessage(), logger);

    expect(atCall).toEqual({
      open: 0,
      ran: [[0, 'BEGIN'], [0, 'CONTEXT'], [0, 'SELECT'], [0, 'UPDATE running'], [0, 'COMMIT']],
      context: undefined,
    });
    // Stage 3: the passed write, a session of its own after the call.
    expect(ran(fake).slice(5)).toEqual([[1, 'BEGIN'], [1, 'CONTEXT'], [1, 'UPDATE passed'], [1, 'COMMIT']]);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
    expect(fake.statements[6]!.values).toEqual([TENANT]);
    expect(fake.open()).toBe(0);
  });

  it('a gateway failure is recorded in a session of its own after the call; none is open during it', async () => {
    const { pool, fake } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: null });
    let openAtCall = -1;
    const gateway = {
      complete: vi.fn(async (): Promise<LLMResponse> => {
        openAtCall = fake.open();
        throw new Error('provider boom');
      }),
    } as unknown as LLMGateway;
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo: new InMemoryAuditRepository() });

    await expect(worker.handle(buildMessage(), logger)).rejects.toThrow('provider boom');

    expect(openAtCall).toBe(0);
    expect(ran(fake)).toEqual([
      [0, 'BEGIN'], [0, 'CONTEXT'], [0, 'SELECT'], [0, 'UPDATE running'], [0, 'COMMIT'],
      [1, 'BEGIN'], [1, 'CONTEXT'], [1, 'UPDATE failed'], [1, 'COMMIT'],
    ]);
    expect(fake.open()).toBe(0);
  });

  it('already passed: one session, the read only — no write, no gateway call', async () => {
    const { pool, fake } = makePool({ ai_model: 'gpt-4o-mini', ai_verification_status: 'passed' });
    const gateway = gatewayReturning('pong');
    const worker = createVerifyAiWorker({ pool, gateway, auditRepo: new InMemoryAuditRepository() });

    await worker.handle(buildMessage(), logger);

    expect(ran(fake)).toEqual([[0, 'BEGIN'], [0, 'CONTEXT'], [0, 'SELECT'], [0, 'COMMIT']]);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('no ai_model: the read and the ai_config_missing write share one session', async () => {
    const { pool, fake } = makePool({ ai_model: null, ai_verification_status: null });
    const worker = createVerifyAiWorker({ pool, gateway: gatewayReturning('pong'), auditRepo: new InMemoryAuditRepository() });

    await worker.handle(buildMessage(), logger);

    expect(ran(fake)).toEqual([[0, 'BEGIN'], [0, 'CONTEXT'], [0, 'SELECT'], [0, 'UPDATE failed'], [0, 'COMMIT']]);
  });

  it('a failed stage-1 write rolls its session back and never reaches the gateway', async () => {
    const fake = fakeTenantPool((sql) => {
      if (SESSION.test(sql)) return undefined;
      if (/^\s*SELECT/i.test(sql)) return { rows: [{ ai_model: 'gpt-4o-mini', ai_verification_status: null }] };
      throw new Error('db down');
    });
    const gateway = gatewayReturning('pong');
    const worker = createVerifyAiWorker({ pool: fake.pool, gateway, auditRepo: new InMemoryAuditRepository() });

    await expect(worker.handle(buildMessage(), logger)).rejects.toThrow('db down');

    expect(fake.statements.map((st) => st.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'ROLLBACK']);
    expect(gateway.complete).not.toHaveBeenCalled();
    expect(fake.open()).toBe(0);
  });
});
