import {
  assembleTechnicianContext,
  validateTechnicianContextInput,
  InMemoryTechnicianUpdateRepository,
  InMemoryConversationRepository,
} from '../../src/invoices/invoice-context';

describe('P5-002B — Technician updates + conversation in invoice context', () => {
  let updateRepo: InMemoryTechnicianUpdateRepository;
  let conversationRepo: InMemoryConversationRepository;

  const tenantId = 'tenant-1';
  const jobId = 'job-1';

  beforeEach(() => {
    updateRepo = new InMemoryTechnicianUpdateRepository();
    conversationRepo = new InMemoryConversationRepository();
  });

  it('happy path — returns technician updates and conversations', async () => {
    updateRepo.addUpdate(tenantId, jobId, {
      id: 'update-1',
      technicianId: 'tech-1',
      technicianName: 'Bob Tech',
      updateType: 'work_completed',
      content: 'Replaced compressor and recharged system',
      timestamp: new Date(),
    });

    conversationRepo.addMessage(tenantId, jobId, {
      id: 'msg-1',
      role: 'technician',
      content: 'Job is done, AC is working fine now',
      timestamp: new Date(),
    });

    const ctx = await assembleTechnicianContext(tenantId, jobId, {
      updateRepo, conversationRepo,
    });

    expect(ctx.updates).toHaveLength(1);
    expect(ctx.updates[0].technicianName).toBe('Bob Tech');
    expect(ctx.conversations).toHaveLength(1);
    expect(ctx.conversations[0].content).toContain('AC is working');
  });

  it('validation — missing tenantId rejected', () => {
    const errors = validateTechnicianContextInput('', jobId);
    expect(errors).toContain('tenantId is required');
  });

  it('validation — missing jobId rejected', () => {
    const errors = validateTechnicianContextInput(tenantId, '');
    expect(errors).toContain('jobId is required');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    updateRepo.addUpdate(tenantId, jobId, {
      id: 'update-1',
      technicianId: 'tech-1',
      technicianName: 'Bob',
      updateType: 'note',
      content: 'Test',
      timestamp: new Date(),
    });

    const ctx = await assembleTechnicianContext('tenant-2', jobId, {
      updateRepo, conversationRepo,
    });

    expect(ctx.updates).toHaveLength(0);
    expect(ctx.conversations).toHaveLength(0);
  });

  it('empty results — returns empty arrays when no data', async () => {
    const ctx = await assembleTechnicianContext(tenantId, jobId, {
      updateRepo, conversationRepo,
    });

    expect(ctx.updates).toHaveLength(0);
    expect(ctx.conversations).toHaveLength(0);
  });

  it('mock provider — InMemory repos work correctly', async () => {
    updateRepo.addUpdate(tenantId, jobId, {
      id: 'u1', technicianId: 't1', technicianName: 'A',
      updateType: 'note', content: 'x', timestamp: new Date(),
    });
    updateRepo.addUpdate(tenantId, jobId, {
      id: 'u2', technicianId: 't1', technicianName: 'A',
      updateType: 'photo', content: 'y', timestamp: new Date(),
    });

    const ctx = await assembleTechnicianContext(tenantId, jobId, {
      updateRepo, conversationRepo,
    });
    expect(ctx.updates).toHaveLength(2);
  });

  it('malformed AI output — handles empty repos gracefully without throwing', async () => {
    const freshUpdateRepo = new InMemoryTechnicianUpdateRepository();
    const freshConvRepo = new InMemoryConversationRepository();

    const ctx = await assembleTechnicianContext(tenantId, jobId, {
      updateRepo: freshUpdateRepo, conversationRepo: freshConvRepo,
    });

    expect(ctx.updates).toEqual([]);
    expect(ctx.conversations).toEqual([]);
  });
});
