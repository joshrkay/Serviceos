import { v4 as uuidv4 } from 'uuid';

export type AiRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AiRun {
  id: string;
  tenantId: string;
  taskType: string;
  model: string;
  promptVersionId?: string;
  inputSnapshot: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  status: AiRunStatus;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  tokenUsage?: { input?: number; output?: number; total?: number };
  /**
   * Cost of this run in micro-cents (1 cent = 1,000,000 micro-cents — see
   * `ai/gateway/model-pricing.ts` for the precision rationale). Undefined
   * when the run hasn't completed yet; `null` once completed but the model
   * has no known price (never a guessed cost).
   */
  costMicroCents?: number | null;
  correlationId?: string;
  createdBy: string;
  createdAt: Date;
}

export interface CreateAiRunInput {
  tenantId: string;
  taskType: string;
  model: string;
  promptVersionId?: string;
  inputSnapshot: Record<string, unknown>;
  createdBy: string;
  correlationId?: string;
}

export interface AiRunRepository {
  create(run: AiRun): Promise<AiRun>;
  findById(tenantId: string, id: string): Promise<AiRun | null>;
  findByTaskType(tenantId: string, taskType: string): Promise<AiRun[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: AiRunStatus,
    result?: {
      outputSnapshot?: Record<string, unknown>;
      error?: string;
      tokenUsage?: { input?: number; output?: number; total?: number };
      completedAt?: Date;
      durationMs?: number;
      costMicroCents?: number | null;
      /**
       * The model that actually served the request (post-failover), e.g.
       * `response.model` from the gateway. When a failover swaps the serving
       * model (Sonnet -> Haiku), the row's `model` column — set to
       * `resolvedModel` at create() time — must be updated to match, since
       * `costMicroCents` is priced at this model's rates. Omit to leave the
       * existing value alone.
       */
      model?: string;
    }
  ): Promise<AiRun | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a canonical UUID string. `ai_runs.prompt_version_id` is a UUID
 * column, but callers tag prompts with string refs too (the brand-voice
 * composer sends 'brand_voice_v1'); binding one of those made Postgres reject
 * the whole INSERT (OBS-1). Repositories store promptVersionId only when this
 * holds; the gateway files any other ref under input_snapshot.promptRef.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function validateAiRunInput(input: CreateAiRunInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.taskType) errors.push('taskType is required');
  if (!input.model) errors.push('model is required');
  if (!input.inputSnapshot || typeof input.inputSnapshot !== 'object') {
    errors.push('inputSnapshot must be a non-null object');
  }
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

export function createAiRun(input: CreateAiRunInput): AiRun {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    taskType: input.taskType,
    model: input.model,
    promptVersionId: input.promptVersionId,
    inputSnapshot: input.inputSnapshot,
    status: 'pending',
    correlationId: input.correlationId || uuidv4(),
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
}

export function startAiRun(run: AiRun): AiRun {
  return { ...run, status: 'running', startedAt: new Date() };
}

export function completeAiRun(
  run: AiRun,
  output: Record<string, unknown>,
  tokenUsage?: { input?: number; output?: number; total?: number },
  costMicroCents?: number | null
): AiRun {
  const now = new Date();
  return {
    ...run,
    status: 'completed',
    outputSnapshot: output,
    completedAt: now,
    durationMs: run.startedAt ? now.getTime() - run.startedAt.getTime() : undefined,
    tokenUsage,
    costMicroCents,
  };
}

export function failAiRun(run: AiRun, errorMessage: string): AiRun {
  const now = new Date();
  return {
    ...run,
    status: 'failed',
    errorMessage,
    completedAt: now,
    durationMs: run.startedAt ? now.getTime() - run.startedAt.getTime() : undefined,
  };
}

export class InMemoryAiRunRepository implements AiRunRepository {
  private runs: Map<string, AiRun> = new Map();

  async create(run: AiRun): Promise<AiRun> {
    // Mirror PgAiRunRepository: the UUID column never holds a non-UUID ref.
    const stored: AiRun = {
      ...run,
      promptVersionId: isUuid(run.promptVersionId) ? run.promptVersionId : undefined,
    };
    this.runs.set(run.id, stored);
    return { ...stored };
  }

  async findById(tenantId: string, id: string): Promise<AiRun | null> {
    const run = this.runs.get(id);
    if (!run || run.tenantId !== tenantId) return null;
    return { ...run };
  }

  async findByTaskType(tenantId: string, taskType: string): Promise<AiRun[]> {
    return Array.from(this.runs.values()).filter(
      (r) => r.tenantId === tenantId && r.taskType === taskType
    );
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: AiRunStatus,
    result?: {
      outputSnapshot?: Record<string, unknown>;
      error?: string;
      tokenUsage?: { input?: number; output?: number; total?: number };
      completedAt?: Date;
      durationMs?: number;
      costMicroCents?: number | null;
      model?: string;
    }
  ): Promise<AiRun | null> {
    const run = this.runs.get(id);
    if (!run || run.tenantId !== tenantId) return null;

    run.status = status;
    if (status === 'completed' || status === 'failed') {
      // Use caller-supplied timing if provided (gateway is the source of truth);
      // fall back to computing from wall clock for backward compat.
      if (result?.completedAt !== undefined) {
        run.completedAt = result.completedAt;
      } else {
        run.completedAt = new Date();
      }
      if (result?.durationMs !== undefined) {
        run.durationMs = result.durationMs;
      } else if (run.startedAt) {
        run.durationMs = run.completedAt!.getTime() - run.startedAt.getTime();
      }
    }
    if (result?.outputSnapshot) run.outputSnapshot = result.outputSnapshot;
    if (result?.error) run.errorMessage = result.error;
    if (result?.tokenUsage) run.tokenUsage = result.tokenUsage;
    // costMicroCents is legitimately `null` (priced model unknown) — only
    // skip the assignment when the caller didn't pass the field at all.
    if (result && 'costMicroCents' in result) run.costMicroCents = result.costMicroCents;
    if (result?.model) run.model = result.model;

    this.runs.set(id, run);
    return { ...run };
  }
}
