import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export type FeedbackRequestStatus = 'pending' | 'submitted' | 'expired';

export interface FeedbackRequest {
  id: string;
  tenantId: string;
  jobId: string;
  token: string;
  status: FeedbackRequestStatus;
  expiresAt: Date;
  sentAt?: Date;
  createdAt: Date;
}

export interface FeedbackRequestRepository {
  create(request: FeedbackRequest): Promise<FeedbackRequest>;
  findByToken(token: string): Promise<FeedbackRequest | null>;
  findByJob(tenantId: string, jobId: string): Promise<FeedbackRequest | null>;
  markSubmitted(tenantId: string, requestId: string): Promise<void>;
}

export function createFeedbackToken(): string {
  return randomBytes(24).toString('base64url');
}

export function createFeedbackRequest(input: {
  tenantId: string;
  jobId: string;
  expiresAt?: Date;
}): FeedbackRequest {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    token: createFeedbackToken(),
    status: 'pending',
    expiresAt: input.expiresAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
    createdAt: new Date(),
  };
}

export class InMemoryFeedbackRequestRepository implements FeedbackRequestRepository {
  private byId = new Map<string, FeedbackRequest>();
  private byToken = new Map<string, string>();
  private byJob = new Map<string, string>();

  async create(request: FeedbackRequest): Promise<FeedbackRequest> {
    const copy = { ...request };
    this.byId.set(copy.id, copy);
    this.byToken.set(copy.token, copy.id);
    this.byJob.set(`${copy.tenantId}:${copy.jobId}`, copy.id);
    return { ...copy };
  }

  async findByToken(token: string): Promise<FeedbackRequest | null> {
    const id = this.byToken.get(token);
    if (!id) return null;
    const request = this.byId.get(id);
    return request ? { ...request } : null;
  }

  async findByJob(tenantId: string, jobId: string): Promise<FeedbackRequest | null> {
    const id = this.byJob.get(`${tenantId}:${jobId}`);
    if (!id) return null;
    const request = this.byId.get(id);
    return request ? { ...request } : null;
  }

  async markSubmitted(tenantId: string, requestId: string): Promise<void> {
    const existing = this.byId.get(requestId);
    if (!existing || existing.tenantId !== tenantId) return;
    this.byId.set(requestId, { ...existing, status: 'submitted' });
  }
}
