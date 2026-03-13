import {
  createAiRun,
  startAiRun,
  completeAiRun,
  failAiRun,
  validateAiRunInput,
  InMemoryAiRunRepository,
} from '../../src/ai/ai-run';

describe('P0-015 — AI run logging foundation', () => {
  it('happy path — creates AI run with all fields', () => {
    const run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'estimate_generation',
      model: 'claude-sonnet-4-6',
      inputSnapshot: { jobDescription: 'Fix plumbing' },
      createdBy: 'user-1',
    });

    expect(run.id).toBeTruthy();
    expect(run.status).toBe('pending');
    expect(run.taskType).toBe('estimate_generation');
    expect(run.correlationId).toBeTruthy();
  });

  it('happy path — lifecycle: pending → running → completed', () => {
    let run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'summarize',
      model: 'claude-sonnet-4-6',
      inputSnapshot: { text: 'hello' },
      createdBy: 'user-1',
    });

    run = startAiRun(run);
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeInstanceOf(Date);

    run = completeAiRun(run, { summary: 'hi' }, { input: 10, output: 5, total: 15 });
    expect(run.status).toBe('completed');
    expect(run.outputSnapshot).toEqual({ summary: 'hi' });
    expect(run.tokenUsage!.total).toBe(15);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('happy path — lifecycle: pending → running → failed', () => {
    let run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'summarize',
      model: 'claude-sonnet-4-6',
      inputSnapshot: {},
      createdBy: 'user-1',
    });

    run = startAiRun(run);
    run = failAiRun(run, 'Model timeout');
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toBe('Model timeout');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateAiRunInput({
      tenantId: '',
      taskType: '',
      model: '',
      inputSnapshot: null as any,
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('taskType is required');
    expect(errors).toContain('model is required');
    expect(errors).toContain('createdBy is required');
    expect(errors).toContain('inputSnapshot must be a non-null object');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryAiRunRepository();
    const run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'estimate',
      model: 'claude-sonnet-4-6',
      inputSnapshot: { data: 'test' },
      createdBy: 'user-1',
    });
    await repo.create(run);

    const found = await repo.findById('tenant-1', run.id);
    expect(found).not.toBeNull();
    expect(found!.taskType).toBe('estimate');
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryAiRunRepository();
    const run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'estimate',
      model: 'claude-sonnet-4-6',
      inputSnapshot: {},
      createdBy: 'user-1',
    });
    await repo.create(run);

    const found = await repo.findById('other-tenant', run.id);
    expect(found).toBeNull();
  });

  it('malformed AI output handled gracefully — failAiRun preserves timing', () => {
    let run = createAiRun({
      tenantId: 'tenant-1',
      taskType: 'test',
      model: 'test',
      inputSnapshot: {},
      createdBy: 'user-1',
    });
    run = startAiRun(run);
    run = failAiRun(run, 'Malformed JSON response from model');
    expect(run.status).toBe('failed');
    expect(run.completedAt).toBeInstanceOf(Date);
  });
});
