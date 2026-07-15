import { describe, expect, it, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import type { Queue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';

const TENANT_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const OTHER_TENANT_ID = 'b2c3d4e5-f6a7-4901-bcde-f12345678901';
const JOB_ID = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';

function job(tenantId: string): Job {
  return {
    id: JOB_ID,
    tenantId,
    customerId: 'customer-1',
    locationId: 'location-1',
    jobNumber: 'JOB-0001',
    summary: 'Replace filter',
    status: 'in_progress',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildApp(jobRepo: Pick<InMemoryJobRepository, 'findById'>) {
  const send = vi.fn(async () => 'queue-message-1');
  const queue = { send } as unknown as Queue;
  const voiceRepo = new InMemoryVoiceRepository();
  const createRecording = vi.spyOn(voiceRepo, 'create');
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      tenantId: TENANT_ID,
      role: 'technician',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/voice', createVoiceRouter(
    voiceRepo,
    queue,
    undefined,
    undefined,
    undefined,
    { jobRepo },
  ));
  return { app, send, createRecording };
}

const recordingBody = {
  fileId: 'file-1',
  audioUrl: 'https://files.example.test/voice.m4a',
};

describe('POST /api/voice/recordings — verified job context', () => {
  it('verifies the job in the authenticated tenant and queues its id', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job(TENANT_ID));
    const findById = vi.spyOn(jobRepo, 'findById');
    const { app, send } = buildApp(jobRepo);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ ...recordingBody, jobId: JOB_ID });

    expect(response.status).toBe(202);
    expect(findById).toHaveBeenCalledWith(TENANT_ID, JOB_ID);
    expect(send).toHaveBeenCalledWith(
      'transcription',
      expect.objectContaining({ tenantId: TENANT_ID, jobId: JOB_ID }),
      expect.any(String),
    );
  });

  it('rejects a malformed job id before repository or queue work', async () => {
    const jobRepo = new InMemoryJobRepository();
    const findById = vi.spyOn(jobRepo, 'findById');
    const { app, send, createRecording } = buildApp(jobRepo);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ ...recordingBody, jobId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(findById).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(createRecording).not.toHaveBeenCalled();
  });

  it('returns not found for an unknown job without creating or queueing', async () => {
    const jobRepo = new InMemoryJobRepository();
    const { app, send, createRecording } = buildApp(jobRepo);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ ...recordingBody, jobId: JOB_ID });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
    expect(send).not.toHaveBeenCalled();
    expect(createRecording).not.toHaveBeenCalled();
  });

  it('treats a job owned by another tenant as not found and does not queue', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job(OTHER_TENANT_ID));
    const { app, send, createRecording } = buildApp(jobRepo);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ ...recordingBody, jobId: JOB_ID });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
    expect(send).not.toHaveBeenCalled();
    expect(createRecording).not.toHaveBeenCalled();
  });

  it('preserves unscoped recording behavior when job id is absent', async () => {
    const jobRepo = new InMemoryJobRepository();
    const findById = vi.spyOn(jobRepo, 'findById');
    const { app, send } = buildApp(jobRepo);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send(recordingBody);

    expect(response.status).toBe(202);
    expect(findById).not.toHaveBeenCalled();
    const queuedPayload = send.mock.calls[0][1] as Record<string, unknown>;
    expect(queuedPayload).not.toHaveProperty('jobId');
  });
});
