import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { FeedbackRequest, FeedbackRequestRepository, FeedbackRequestStatus } from './feedback-request';

function mapRow(row: Record<string, unknown>): FeedbackRequest {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    token: row.token as string,
    status: row.status as FeedbackRequestStatus,
    expiresAt: new Date(row.expires_at as string),
    sentAt: row.sent_at ? new Date(row.sent_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgFeedbackRequestRepository extends PgBaseRepository implements FeedbackRequestRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(request: FeedbackRequest): Promise<FeedbackRequest> {
    return this.withTenant(request.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO feedback_requests (id, tenant_id, job_id, token, status, expires_at, sent_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [request.id, request.tenantId, request.jobId, request.token, request.status, request.expiresAt, request.sentAt ?? null, request.createdAt]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByToken(token: string): Promise<FeedbackRequest | null> {
    return this.withClient(async (client) => {
      const result = await client.query('SELECT * FROM feedback_requests WHERE token = $1 LIMIT 1', [token]);
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<FeedbackRequest | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM feedback_requests WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC LIMIT 1',
        [tenantId, jobId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async markSubmitted(tenantId: string, requestId: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE feedback_requests
         SET status = 'submitted'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId]
      );
    });
  }
}
