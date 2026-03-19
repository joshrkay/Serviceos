import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { JobTimelineEntry, JobTimelineRepository } from './job-lifecycle';

function mapRow(row: Record<string, unknown>): JobTimelineEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    eventType: row.event_type as string,
    fromStatus: (row.from_status as JobTimelineEntry['fromStatus']) ?? undefined,
    toStatus: (row.to_status as JobTimelineEntry['toStatus']) ?? undefined,
    description: row.description as string,
    actorId: row.actor_id as string,
    actorRole: row.actor_role as string,
    metadata: row.metadata ? (row.metadata as Record<string, unknown>) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgJobTimelineRepository extends PgBaseRepository implements JobTimelineRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(entry: JobTimelineEntry): Promise<JobTimelineEntry> {
    return this.withTenant(entry.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_timeline_events (
          id, tenant_id, job_id, event_type, from_status, to_status,
          description, actor_id, actor_role, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          entry.id,
          entry.tenantId,
          entry.jobId,
          entry.eventType,
          entry.fromStatus ?? null,
          entry.toStatus ?? null,
          entry.description,
          entry.actorId,
          entry.actorRole,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<JobTimelineEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_timeline_events
         WHERE tenant_id = $1 AND job_id = $2
         ORDER BY created_at ASC`,
        [tenantId, jobId]
      );
      return result.rows.map(mapRow);
    });
  }
}
