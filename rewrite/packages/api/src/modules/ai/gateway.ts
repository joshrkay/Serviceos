import { randomUUID } from 'node:crypto';
import { withTenantTransaction, type Db } from '../../core/db';

export interface LLMRequest {
  taskType: string;
  system: string;
  prompt: string;
}

export interface LLMCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(model: string, request: LLMRequest): Promise<LLMCompletion>;
}

export interface TaskRoute {
  provider: string;
  model: string;
  /** microcents per 1K tokens, for ai_runs cost accounting */
  costPer1kInputMicrocents: number;
  costPer1kOutputMicrocents: number;
  timeoutMs: number;
}

export type RoutingConfig = Record<string, TaskRoute>;

export class QuotaExceededError extends Error {
  constructor(tenantId: string) {
    super(`AI daily quota exceeded for tenant ${tenantId}`);
    this.name = 'QuotaExceededError';
  }
}

/**
 * The single sanctioned path for LLM calls. Routes by task type, enforces
 * per-tenant daily quotas, retries once on failure, and records every call
 * (success or error) in ai_runs for cost and audit.
 */
export class LLMGateway {
  constructor(
    private readonly db: Db,
    private readonly providers: Record<string, LLMProvider>,
    private readonly routing: RoutingConfig,
  ) {}

  async run(
    scope: { tenantId: string; correlationId?: string },
    request: LLMRequest,
  ): Promise<LLMCompletion> {
    const route = this.routing[request.taskType];
    if (!route) throw new Error(`no route for AI task type ${request.taskType}`);
    const provider = this.providers[route.provider];
    if (!provider) throw new Error(`unknown AI provider ${route.provider}`);

    await this.enforceQuota(scope.tenantId);

    const startedAt = Date.now();
    try {
      const completion = await this.callWithRetry(provider, route, request);
      await this.recordRun(scope, request.taskType, route, {
        status: 'ok',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        latencyMs: Date.now() - startedAt,
      });
      return completion;
    } catch (err) {
      await this.recordRun(scope, request.taskType, route, {
        status: 'error',
        error: (err as Error).message.slice(0, 1000),
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  private async callWithRetry(
    provider: LLMProvider,
    route: TaskRoute,
    request: LLMRequest,
  ): Promise<LLMCompletion> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await withTimeout(provider.complete(route.model, request), route.timeoutMs);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error('LLM call failed');
  }

  private async enforceQuota(tenantId: string): Promise<void> {
    const exceeded = await withTenantTransaction(this.db, tenantId, async (client) => {
      const { rows } = await client.query<{ quota: number; used: string }>(
        `SELECT t.ai_daily_quota AS quota,
                (SELECT COUNT(*) FROM ai_runs r
                 WHERE r.tenant_id = t.id AND r.created_at > now() - interval '1 day') AS used
         FROM tenants t WHERE t.id = $1`,
        [tenantId],
      );
      const row = rows[0];
      return row ? Number(row.used) >= row.quota : true;
    });
    if (exceeded) throw new QuotaExceededError(tenantId);
  }

  private async recordRun(
    scope: { tenantId: string; correlationId?: string },
    taskType: string,
    route: TaskRoute,
    outcome: {
      status: 'ok' | 'error';
      inputTokens?: number;
      outputTokens?: number;
      latencyMs: number;
      error?: string;
    },
  ): Promise<void> {
    const inputTokens = outcome.inputTokens ?? 0;
    const outputTokens = outcome.outputTokens ?? 0;
    const costMicrocents = Math.round(
      (inputTokens * route.costPer1kInputMicrocents + outputTokens * route.costPer1kOutputMicrocents) / 1000,
    );
    await withTenantTransaction(this.db, scope.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_runs (tenant_id, task_type, provider, model, input_tokens, output_tokens,
                              cost_microcents, latency_ms, status, error, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          scope.tenantId,
          taskType,
          route.provider,
          route.model,
          inputTokens,
          outputTokens,
          costMicrocents,
          outcome.latencyMs,
          outcome.status,
          outcome.error ?? null,
          scope.correlationId ?? randomUUID(),
        ],
      );
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
