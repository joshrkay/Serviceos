/**
 * P7-026 PR a — Postgres-backed ReviewRepository.
 *
 * The worker is system-scoped (no request context, no
 * tenantContextStore), so all writes go through `withTenant` which
 * sets `app.current_tenant_id` on a fresh connection per call — the
 * RLS policy on `google_reviews` then enforces tenant isolation.
 *
 * Idempotency is enforced at the DB layer via the
 * `(tenant_id, external_review_id)` UNIQUE constraint plus
 * `ON CONFLICT DO UPDATE`. The `xmax = 0` trick distinguishes a true
 * INSERT from an UPDATE so we can report `inserted` accurately to the
 * worker for counting-only purposes (no behavior depends on it).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Review,
  ReviewRepository,
  ReviewUpsertResult,
} from './review';

interface ReviewRow {
  id: string;
  tenant_id: string;
  external_review_id: string;
  location_id: string;
  reviewer_display_name: string | null;
  reviewer_profile_url: string | null;
  rating: number;
  comment_text: string | null;
  review_create_time: string;
  review_update_time: string | null;
  fetched_at: string;
}

function mapRow(row: ReviewRow): Review {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalReviewId: row.external_review_id,
    locationId: row.location_id,
    reviewerDisplayName: row.reviewer_display_name,
    reviewerProfileUrl: row.reviewer_profile_url,
    rating: row.rating,
    commentText: row.comment_text,
    createTime: new Date(row.review_create_time),
    updateTime: row.review_update_time
      ? new Date(row.review_update_time)
      : null,
    fetchedAt: new Date(row.fetched_at),
  };
}

export class PgReviewRepository
  extends PgBaseRepository
  implements ReviewRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(review: Review): Promise<ReviewUpsertResult> {
    return this.withTenant(review.tenantId, async (client) => {
      const result = await client.query<ReviewRow & { is_insert: boolean }>(
        `INSERT INTO google_reviews (
           id, tenant_id, external_review_id, location_id,
           reviewer_display_name, reviewer_profile_url,
           rating, comment_text,
           review_create_time, review_update_time, fetched_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, external_review_id) DO UPDATE
           SET reviewer_display_name = EXCLUDED.reviewer_display_name,
               reviewer_profile_url  = EXCLUDED.reviewer_profile_url,
               rating                = EXCLUDED.rating,
               comment_text          = EXCLUDED.comment_text,
               review_update_time    = EXCLUDED.review_update_time
         RETURNING *, (xmax = 0) AS is_insert`,
        [
          review.id,
          review.tenantId,
          review.externalReviewId,
          review.locationId,
          review.reviewerDisplayName,
          review.reviewerProfileUrl,
          review.rating,
          review.commentText,
          review.createTime,
          review.updateTime,
          review.fetchedAt,
        ],
      );
      const row = result.rows[0];
      return { review: mapRow(row), inserted: row.is_insert };
    });
  }

  async findByExternalId(
    tenantId: string,
    externalReviewId: string,
  ): Promise<Review | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ReviewRow>(
        `SELECT * FROM google_reviews
         WHERE tenant_id = $1 AND external_review_id = $2`,
        [tenantId, externalReviewId],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
