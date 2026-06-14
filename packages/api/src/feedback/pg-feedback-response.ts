import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  FeedbackResponse,
  FeedbackResponseListOptions,
  FeedbackResponseRepository,
  RatingCounts,
} from './feedback-response';

function mapRow(row: Record<string, unknown>): FeedbackResponse {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    requestId: row.request_id as string,
    jobId: row.job_id as string,
    rating: Number(row.rating),
    comment: (row.comment as string | null) ?? null,
    submittedAt: new Date(row.submitted_at as string),
  };
}

export class PgFeedbackResponseRepository extends PgBaseRepository implements FeedbackResponseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(response: FeedbackResponse): Promise<FeedbackResponse> {
    return this.withTenant(response.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO feedback_responses (id, tenant_id, request_id, job_id, rating, comment, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [response.id, response.tenantId, response.requestId, response.jobId, response.rating, response.comment, response.submittedAt]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByRequest(tenantId: string, requestId: string): Promise<FeedbackResponse | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM feedback_responses WHERE tenant_id = $1 AND request_id = $2 LIMIT 1',
        [tenantId, requestId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async listByTenant(
    tenantId: string,
    options: FeedbackResponseListOptions = {}
  ): Promise<{ responses: FeedbackResponse[]; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    return this.withTenant(tenantId, async (client) => {
      const [rowsResult, countResult] = await Promise.all([
        client.query(
          `SELECT * FROM feedback_responses
           WHERE tenant_id = $1
           ORDER BY submitted_at DESC
           LIMIT $2 OFFSET $3`,
          [tenantId, limit, offset]
        ),
        client.query('SELECT COUNT(*) AS total FROM feedback_responses WHERE tenant_id = $1', [tenantId]),
      ]);

      return {
        responses: rowsResult.rows.map(mapRow),
        total: Number(countResult.rows[0]?.total ?? 0),
      };
    });
  }

  async countByRatingInRange(
    tenantId: string,
    utcStart: Date,
    utcEnd: Date
  ): Promise<RatingCounts> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT rating, COUNT(*)::int AS count
         FROM feedback_responses
         WHERE tenant_id = $1 AND submitted_at >= $2 AND submitted_at < $3
         GROUP BY rating`,
        [tenantId, utcStart, utcEnd]
      );
      const counts: RatingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const row of result.rows) {
        const rating = Number(row.rating);
        if (rating >= 1 && rating <= 5) {
          counts[rating as 1 | 2 | 3 | 4 | 5] = Number(row.count);
        }
      }
      return counts;
    });
  }
}
