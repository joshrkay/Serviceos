import { describe, it, expect, beforeEach } from 'vitest';
import { AttachJobPhotoExecutionHandler } from '../../src/proposals/execution/attach-photo-handler';
import { JobPhotoService } from '../../src/jobs/job-photo-service';
import { InMemoryJobPhotoRepository } from '../../src/jobs/job-photo';
import {
  InMemoryFileRepository,
  StorageProvider,
  ObjectMetadata,
} from '../../src/files/file-service';

class FakeStorageProvider implements StorageProvider {
  async generateUploadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/put/${bucket}/${key}`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/get/${bucket}/${key}`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }
  async deleteObject(): Promise<void> {
    return;
  }
}
import type { Proposal } from '../../src/proposals/proposal';

const TENANT = '00000000-0000-0000-0000-000000000001';
const JOB = '00000000-0000-0000-0000-0000000000aa';
const FILE = '00000000-0000-0000-0000-0000000000bb';
const USER = 'user-1';

function makeProposal(): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'attach_job_photo',
    status: 'approved',
    payload: {
      jobId: JOB,
      fileId: FILE,
      category: 'before',
      notes: 'leak photo',
    },
    summary: 'Attach before photo',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AttachJobPhotoExecutionHandler', () => {
  let handler: AttachJobPhotoExecutionHandler;
  let fileRepo: InMemoryFileRepository;

  beforeEach(async () => {
    fileRepo = new InMemoryFileRepository();
    await fileRepo.create({
      id: FILE,
      tenantId: TENANT,
      uploadedBy: USER,
      filename: 'leak.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1000,
      entityType: 'job',
      entityId: JOB,
      storageBucket: 'test',
      storageKey: 'k',
      createdAt: new Date(),
    });
    const service = new JobPhotoService(
      new InMemoryJobPhotoRepository(),
      fileRepo,
      new FakeStorageProvider(),
    );
    handler = new AttachJobPhotoExecutionHandler(service);
  });

  it('attaches a photo to a job', async () => {
    const result = await handler.execute(makeProposal(), {
      tenantId: TENANT,
      executedBy: USER,
    });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });
});
