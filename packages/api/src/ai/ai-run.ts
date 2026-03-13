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
    }
  ): Promise<AiRun | null>;
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
  tokenUsage?: { input?: number; output?: number; total?: number }
): AiRun {
  const now = new Date();
  return {
    ...run,
    status: 'completed',
    outputSnapshot: output,
    completedAt: now,
    durationMs: run.startedAt ? now.getTime() - run.startedAt.getTime() : undefined,
    tokenUsage,
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
    this.runs.set(run.id, { ...run });
    return run;
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
    }
  ): Promise<AiRun | null> {
    const run = this.runs.get(id);
    if (!run || run.tenantId !== tenantId) return null;

    run.status = status;
    if (status === 'completed' || status === 'failed') {
      run.completedAt = new Date();
      if (run.startedAt) {
        run.durationMs = run.completedAt.getTime() - run.startedAt.getTime();
      }
    }
    if (result?.outputSnapshot) run.outputSnapshot = result.outputSnapshot;
    if (result?.error) run.errorMessage = result.error;
    if (result?.tokenUsage) run.tokenUsage = result.tokenUsage;

    this.runs.set(id, run);
    return { ...run };
  }
}
