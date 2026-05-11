/**
 * /api/interactions — call log surface.
 *
 * Exposes completed voice sessions with their persisted transcript and
 * linked customer information. Satisfies QA checklist items 15.8 and 15.9:
 *   15.8 — transcript appears in /interactions with the correct customer linked
 *   15.9 — transcript contains the actual words spoken (not blank / [inaudible])
 *
 * Routes:
 *   GET /api/interactions           — paginated list (newest first)
 *   GET /api/interactions/:id       — single interaction with full transcript
 */

import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { setTenantContext } from '../db/schema';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'routes.interactions',
  environment: process.env.NODE_ENV || 'development',
});

export interface InteractionSummary {
  id: string;
  channel: string;
  outcome: string | null;
  callSid: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  customer: {
    id: string;
    displayName: string;
    address: string | null;
  } | null;
  /** Excerpt: first caller turn (≤ 200 chars) or null when transcript empty. */
  excerpt: string | null;
  transcriptTurnCount: number;
}

export interface InteractionDetail extends InteractionSummary {
  transcript: string[];
  endedReason: string | null;
  costCents: number;
}

export interface InteractionsRouterDeps {
  pool: Pool;
}

export function createInteractionsRouter(deps: InteractionsRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/interactions
   *
   * Query params:
   *   limit   — number of results (default 50, max 200)
   *   offset  — pagination offset (default 0)
   *   customerId — filter to sessions linked to this customer UUID
   */
  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
        const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
        const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
        const customerIdFilter = typeof req.query.customerId === 'string' ? req.query.customerId : null;

        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(setTenantContext(tenantId));

          const conditions: string[] = ['vs.tenant_id = $1', 'vs.ended_at IS NOT NULL'];
          const params: unknown[] = [tenantId];
          let idx = 2;

          if (customerIdFilter) {
            conditions.push(`vs.customer_id = $${idx}`);
            params.push(customerIdFilter);
            idx++;
          }

          const countResult = await client.query<{ total: string }>(
            `SELECT COUNT(*) AS total FROM voice_sessions vs WHERE ${conditions.join(' AND ')}`,
            params,
          );
          const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

          params.push(limit, offset);
          const rows = await client.query(
            `SELECT
               vs.id,
               vs.channel,
               vs.outcome,
               vs.call_sid,
               vs.started_at,
               vs.ended_at,
               vs.cost_cents,
               vs.transcript,
               vs.customer_id,
               c.display_name AS customer_display_name,
               c.address      AS customer_address
             FROM voice_sessions vs
             LEFT JOIN customers c
               ON c.id = vs.customer_id AND c.tenant_id = vs.tenant_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY vs.started_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            params,
          );

          await client.query('COMMIT');

          const data: InteractionSummary[] = rows.rows.map((r) => {
            const turns: string[] = Array.isArray(r.transcript) ? r.transcript : [];
            const callerTurn = turns.find((t) => typeof t === 'string' && t.startsWith('caller:'));
            const excerpt = callerTurn
              ? callerTurn.replace(/^caller:\s*/i, '').slice(0, 200)
              : null;
            const durationSeconds =
              r.ended_at && r.started_at
                ? Math.round(
                    (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000,
                  )
                : null;
            return {
              id: r.id as string,
              channel: r.channel as string,
              outcome: (r.outcome as string | null) ?? null,
              callSid: (r.call_sid as string | null) ?? null,
              startedAt: (r.started_at as Date).toISOString(),
              endedAt: r.ended_at ? (r.ended_at as Date).toISOString() : null,
              durationSeconds,
              customer: r.customer_id
                ? {
                    id: r.customer_id as string,
                    displayName: (r.customer_display_name as string | null) ?? 'Unknown',
                    address: (r.customer_address as string | null) ?? null,
                  }
                : null,
              excerpt,
              transcriptTurnCount: turns.length,
            };
          });

          res.json({ data, total, limit, offset });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error('interactions/list failed', {
          tenantId: req.auth?.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * GET /api/interactions/:id
   *
   * Returns the full transcript array alongside session metadata and
   * the linked customer record.
   */
  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id } = req.params;

        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(setTenantContext(tenantId));

          const result = await client.query(
            `SELECT
               vs.id,
               vs.channel,
               vs.outcome,
               vs.call_sid,
               vs.started_at,
               vs.ended_at,
               vs.ended_reason,
               vs.cost_cents,
               vs.transcript,
               vs.customer_id,
               c.display_name AS customer_display_name,
               c.address      AS customer_address
             FROM voice_sessions vs
             LEFT JOIN customers c
               ON c.id = vs.customer_id AND c.tenant_id = vs.tenant_id
             WHERE vs.id = $1 AND vs.tenant_id = $2`,
            [id, tenantId],
          );

          await client.query('COMMIT');

          if (result.rows.length === 0) {
            res.status(404).json({ error: 'NOT_FOUND', message: 'Interaction not found' });
            return;
          }

          const r = result.rows[0];
          const turns: string[] = Array.isArray(r.transcript) ? r.transcript : [];
          const callerTurn = turns.find((t) => typeof t === 'string' && t.startsWith('caller:'));
          const excerpt = callerTurn
            ? callerTurn.replace(/^caller:\s*/i, '').slice(0, 200)
            : null;
          const durationSeconds =
            r.ended_at && r.started_at
              ? Math.round(
                  (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000,
                )
              : null;

          const detail: InteractionDetail = {
            id: r.id as string,
            channel: r.channel as string,
            outcome: (r.outcome as string | null) ?? null,
            callSid: (r.call_sid as string | null) ?? null,
            startedAt: (r.started_at as Date).toISOString(),
            endedAt: r.ended_at ? (r.ended_at as Date).toISOString() : null,
            durationSeconds,
            endedReason: (r.ended_reason as string | null) ?? null,
            costCents: (r.cost_cents as number) ?? 0,
            customer: r.customer_id
              ? {
                  id: r.customer_id as string,
                  displayName: (r.customer_display_name as string | null) ?? 'Unknown',
                  address: (r.customer_address as string | null) ?? null,
                }
              : null,
            excerpt,
            transcriptTurnCount: turns.length,
            transcript: turns,
          };

          res.json(detail);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error('interactions/detail failed', {
          tenantId: req.auth?.tenantId,
          interactionId: req.params.id,
          error: err instanceof Error ? err.message : String(err),
        });
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
