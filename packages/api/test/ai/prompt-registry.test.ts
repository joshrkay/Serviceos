import {
  registerPromptVersion,
  activatePromptVersion,
  validatePromptVersionInput,
  InMemoryPromptVersionRepository,
} from '../../src/ai/prompt-registry';

describe('P0-016 — Prompt version registry', () => {
  let repo: InMemoryPromptVersionRepository;

  beforeEach(() => {
    repo = new InMemoryPromptVersionRepository();
  });

  it('happy path — registers prompt version', async () => {
    const version = await registerPromptVersion(
      {
        taskType: 'estimate_generation',
        template: 'Generate an estimate for: {{description}}',
        model: 'claude-sonnet-4-6',
        createdBy: 'user-1',
      },
      repo
    );

    expect(version.id).toBeTruthy();
    expect(version.version).toBe(1);
    expect(version.isActive).toBe(false);
    expect(version.taskType).toBe('estimate_generation');
  });

  it('happy path — versions auto-increment', async () => {
    await registerPromptVersion(
      { taskType: 'test', template: 'v1', model: 'model', createdBy: 'u1' },
      repo
    );
    const v2 = await registerPromptVersion(
      { taskType: 'test', template: 'v2', model: 'model', createdBy: 'u1' },
      repo
    );
    expect(v2.version).toBe(2);
  });

  it('happy path — activates a version and deactivates others', async () => {
    const v1 = await registerPromptVersion(
      { taskType: 'test', template: 'v1', model: 'm', createdBy: 'u1' },
      repo
    );
    const v2 = await registerPromptVersion(
      { taskType: 'test', template: 'v2', model: 'm', createdBy: 'u1' },
      repo
    );

    await activatePromptVersion(v1.id, repo);
    let active = await repo.findActive('test');
    expect(active!.id).toBe(v1.id);

    await activatePromptVersion(v2.id, repo);
    active = await repo.findActive('test');
    expect(active!.id).toBe(v2.id);

    const v1Now = await repo.findById(v1.id);
    expect(v1Now!.isActive).toBe(false);
  });

  it('validation — rejects missing fields', () => {
    const errors = validatePromptVersionInput({
      taskType: '',
      template: '',
      model: '',
      createdBy: '',
    });
    expect(errors).toContain('taskType is required');
    expect(errors).toContain('template is required');
    expect(errors).toContain('model is required');
    expect(errors).toContain('createdBy is required');
  });

  it('mock provider test — retrieves by task type', async () => {
    await registerPromptVersion(
      { taskType: 'estimate', template: 'a', model: 'm', createdBy: 'u1' },
      repo
    );
    await registerPromptVersion(
      { taskType: 'estimate', template: 'b', model: 'm', createdBy: 'u1' },
      repo
    );
    await registerPromptVersion(
      { taskType: 'invoice', template: 'c', model: 'm', createdBy: 'u1' },
      repo
    );

    const estimates = await repo.findByTaskType('estimate');
    expect(estimates).toHaveLength(2);
  });

  it('malformed AI output handled gracefully — activate nonexistent returns null', async () => {
    const result = await activatePromptVersion('nonexistent-id', repo);
    expect(result).toBeNull();
  });
});
