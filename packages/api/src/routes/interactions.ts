import { Pool } from 'pg';
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import type { DispatchRepository } from '../notifications/dispatch-repository';

export interface InteractionsRouterDeps {
  pool: Pool;
  dispatchRepo: DispatchRepository;
}

function toExcerpt(transcript: string[] | null): string {
  if (!transcript || transcript.length === 0) return '';
  const callerTurn = transcript.find(t => /^caller:/i.test(t));
  const source = callerTurn ?? transcript[0];
  return source.replace(/^(caller|agent):\s*/i, '').slice(0, 120);
}

function toCustomer(row: Record<string, unknown>) {
  if (!row.customer_id) return null;
  return {
    id: row.customer_id,
    displayName: row.customer_display_name ?? null,
    address: row.customer_address ?? null,
  };
}

const SESSION_COLUMNS = `
  vs.id, vs.channel, vs.outcome, vs.call_sid,
  vs.started_at, vs.ended_at, vs.ended_reason, vs.cost_cents,
  vs.transcript, vs.customer_id,
  c.display_name AS customer_display_name,
  -- One address per session. A LEFT JOIN to service_locations fans each session
  -- into N rows for a customer with N locations, which duplicated interactions
  -- and broke LIMIT/OFFSET pagination (it paginates the fanned-out rows, while
  -- the total counts distinct sessions). A correlated scalar subquery returns
  -- exactly one row, preferring the primary address (same ordering as
  -- pg-location.ts / resolveBillingLocation).
  (
    SELECT l.street1
    FROM service_locations l
    WHERE l.customer_id = c.id AND l.tenant_id = vs.tenant_id
    ORDER BY l.is_primary DESC, l.created_at ASC
    LIMIT 1
  ) AS customer_address
FROM voice_sessions vs
LEFT JOIN customers c ON c.id = vs.customer_id AND c.tenant_id = vs.tenant_id`;

export function createInteractionsRouter(deps: InteractionsRouterDeps): Router {
  const { pool, dispatchRepo } = deps;
  const router = Router();

  router.get('/', requireAuth, requireTenant, asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const rawLimit = req.query.limit as string | undefined;
    const rawOffset = req.query.offset as string | undefined;
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (Number.isNaN(limit) || limit < 1 || limit > 200) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'limit must be between 1 and 200' });
      return;
    }
    if (Number.isNaN(offset) || offset < 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'offset must be a non-negative integer' });
      return;
    }

    const client = await pool.connect();
    try {
      const tenantId = req.auth!.tenantId;
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      const [countResult, dataResult] = await Promise.all([
        client.query(`SELECT COUNT(*) AS total FROM voice_sessions WHERE tenant_id = $1`, [tenantId]),
        client.query(
          `SELECT ${SESSION_COLUMNS} WHERE vs.tenant_id = $1 ORDER BY vs.started_at DESC LIMIT $2 OFFSET $3`,
          [tenantId, limit, offset],
        ),
      ]);

      await client.query('COMMIT');

      const total = parseInt((countResult.rows[0] as { total: string })?.total ?? '0', 10);
      const data = dataResult.rows.map(row => {
        const transcript = Array.isArray(row.transcript) ? (row.transcript as string[]) : null;
        const startedAt = row.started_at ? new Date(row.started_at as string) : null;
        const endedAt = row.ended_at ? new Date(row.ended_at as string) : null;
        const durationSeconds =
          startedAt && endedAt
            ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
            : null;

        return {
          id: row.id,
          channel: row.channel,
          outcome: row.outcome,
          callSid: row.call_sid,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          endedReason: row.ended_reason,
          costCents: row.cost_cents,
          durationSeconds,
          transcriptTurnCount: transcript ? transcript.length : 0,
          excerpt: toExcerpt(transcript),
          customer: toCustomer(row as Record<string, unknown>),
        };
      });

      res.json({ data, total, limit, offset });
    } catch (err) {
      // Without this, an error mid-transaction releases the client with the
      // transaction (and tenant GUC) still open — the next checkout gets a
      // dirty connection. Best-effort rollback, then rethrow for asyncRoute.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  /**
   * GET /api/interactions/dispatches?limit=&offset=
   *
   * Outbound message dispatch log (SMS / email) — appointment
   * confirmations, delay notices, estimate / invoice deliveries. Backs
   * the web DispatchLogPage. Gated by `dispatch:view` (owner + dispatcher;
   * technicians get a 403 — they have no billing/comms surface). Registered
   * before `/:id` so "dispatches" isn't matched as an interaction id.
   */
  router.get('/dispatches', requireAuth, requireTenant, requirePermission('dispatch:view'), asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const rawLimit = req.query.limit as string | undefined;
    const rawOffset = req.query.offset as string | undefined;
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (Number.isNaN(limit) || limit < 1 || limit > 200) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'limit must be between 1 and 200' });
      return;
    }
    if (Number.isNaN(offset) || offset < 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'offset must be a non-negative integer' });
      return;
    }

    const tenantId = req.auth!.tenantId;
    const { dispatches, total } = await dispatchRepo.listByTenant(tenantId, { limit, offset });

    res.json({ dispatches, total, limit, offset });
  }));

  router.get('/:id', requireAuth, requireTenant, asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      const result = await client.query(
        `SELECT ${SESSION_COLUMNS} WHERE vs.tenant_id = $1 AND vs.id = $2`,
        [tenantId, id],
      );

      await client.query('COMMIT');

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Interaction not found' });
        return;
      }

      const row = result.rows[0];
      const transcript = Array.isArray(row.transcript) ? (row.transcript as string[]) : [];

      res.json({
        id: row.id,
        channel: row.channel,
        outcome: row.outcome,
        callSid: row.call_sid,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        endedReason: row.ended_reason,
        costCents: row.cost_cents,
        transcript,
        customer: toCustomer(row as Record<string, unknown>),
      });
    } catch (err) {
      // Same dirty-connection guard as the list route above.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  return router;
}
