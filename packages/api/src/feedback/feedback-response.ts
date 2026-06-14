import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * D2-1d — synthetic public actor for token-scoped audit rows. The
 * raw token is NEVER persisted to the audit row; we store a 12-char
 * SHA-256 prefix so the row can be correlated to the originating
 * link without leaking the bearer credential itself.
 */
export function publicActorFromToken(token: string): string {
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  return `public:${hash}`;
}

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

/** Per-star response counts for a tenant over a time window. */
export interface RatingCounts {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

/** Total responses across all five star buckets. */
export function totalResponses(counts: RatingCounts): number {
  return counts[1] + counts[2] + counts[3] + counts[4] + counts[5];
}

/** Mean rating rounded to one decimal, or null when there are no responses. */
export function averageRating(counts: RatingCounts): number | null {
  const total = totalResponses(counts);
  if (total === 0) return null;
  const sum = counts[1] + counts[2] * 2 + counts[3] * 3 + counts[4] * 4 + counts[5] * 5;
  return Math.round((sum / total) * 10) / 10;
}

/** Count of low ratings (≤3★) — the ones that route to internal feedback. */
export function lowRatingCount(counts: RatingCounts): number {
  return counts[1] + counts[2] + counts[3];
}

export interface FeedbackResponseRepository {
  create(response: FeedbackResponse): Promise<FeedbackResponse>;
  findByRequest(tenantId: string, requestId: string): Promise<FeedbackResponse | null>;
  listByTenant(
    tenantId: string,
    options?: FeedbackResponseListOptions
  ): Promise<{ responses: FeedbackResponse[]; total: number }>;
  /**
   * Per-star response counts for responses submitted in the half-open window
   * [utcStart, utcEnd). Tenant-scoped. Used by the end-of-day digest line.
   */
  countByRatingInRange(
    tenantId: string,
    utcStart: Date,
    utcEnd: Date
  ): Promise<RatingCounts>;
}

function emptyRatingCounts(): RatingCounts {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
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

  async countByRatingInRange(
    tenantId: string,
    utcStart: Date,
    utcEnd: Date
  ): Promise<RatingCounts> {
    const counts = emptyRatingCounts();
    const startMs = utcStart.getTime();
    const endMs = utcEnd.getTime();
    for (const response of this.byId.values()) {
      if (response.tenantId !== tenantId) continue;
      const t = response.submittedAt.getTime();
      if (t < startMs || t >= endMs) continue;
      if (response.rating >= 1 && response.rating <= 5) {
        counts[response.rating as 1 | 2 | 3 | 4 | 5] += 1;
      }
    }
    return counts;
  }
}
