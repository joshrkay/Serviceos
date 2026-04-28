import { v4 as uuidv4 } from 'uuid';

export interface FeedbackResponse {
  id: string;
  tenantId: string;
  requestId: string;
  jobId: string;
  rating: number;
  comment: string | null;
  submittedAt: Date;
}

export interface FeedbackResponseListOptions {
  limit?: number;
  offset?: number;
}

export interface FeedbackResponseRepository {
  create(response: FeedbackResponse): Promise<FeedbackResponse>;
  findByRequest(tenantId: string, requestId: string): Promise<FeedbackResponse | null>;
  listByTenant(
    tenantId: string,
    options?: FeedbackResponseListOptions
  ): Promise<{ responses: FeedbackResponse[]; total: number }>;
}

export function createFeedbackResponse(input: {
  tenantId: string;
  requestId: string;
  jobId: string;
  rating: number;
  comment?: string | null;
}): FeedbackResponse {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    requestId: input.requestId,
    jobId: input.jobId,
    rating: input.rating,
    comment: input.comment ?? null,
    submittedAt: new Date(),
  };
}

export class InMemoryFeedbackResponseRepository implements FeedbackResponseRepository {
  private byId = new Map<string, FeedbackResponse>();

  async create(response: FeedbackResponse): Promise<FeedbackResponse> {
    const copy = { ...response };
    this.byId.set(copy.id, copy);
    return { ...copy };
  }

  async findByRequest(tenantId: string, requestId: string): Promise<FeedbackResponse | null> {
    const match = Array.from(this.byId.values()).find(
      (response) => response.tenantId === tenantId && response.requestId === requestId
    );
    return match ? { ...match } : null;
  }

  async listByTenant(
    tenantId: string,
    options: FeedbackResponseListOptions = {}
  ): Promise<{ responses: FeedbackResponse[]; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const all = Array.from(this.byId.values())
      .filter((response) => response.tenantId === tenantId)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());

    return {
      responses: all.slice(offset, offset + limit).map((response) => ({ ...response })),
      total: all.length,
    };
  }
}
