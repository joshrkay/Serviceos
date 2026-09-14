/**
 * Route hardening tests: Standing instructions (#1110, extends the #882 / #1096 sweep)
 *
 * `PATCH /api/standing-instructions/:id/deactivate` passes `req.params.id` into
 * `PgStandingInstructionRepository.findById`, whose
 * `WHERE tenant_id = $n AND id = $n` compares against a `uuid` column. A
 * non-UUID id reached Postgres, threw `invalid input syntax for type uuid`,
 * and `asyncRoute` answered a bare `500 INTERNAL_ERROR`.
 *
 * The PgLike subclass throws exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryStandingInstructionRepository,
  createStandingInstruction,
} from '../../src/instructions/standing-instructions';
import { createStandingInstructionRouter } from '../../src/routes/standing-instructions';

const TENANT = 'tenant-standing-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeStandingInstructionRepository extends InMemoryStandingInstructionRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async deactivate(tenantId: string, id: string, deactivatedBy: string) {
    castUuid(id);
    return super.deactivate(tenantId, id, deactivatedBy);
  }
}

function buildApp(repo: InMemoryStandingInstructionRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-standing-malformed',
        sessionId: 'sess-standing-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/standing-instructions',
    createStandingInstructionRouter(repo, new InMemoryAuditRepository()),
  );
  return app;
}

const deactivate = (app: Express, id: string) =>
  request(app).patch(`/api/standing-instructions/${id}/deactivate`).send({});

describe('standing instructions: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeStandingInstructionRepository;

  beforeEach(() => {
    repo = new PgLikeStandingInstructionRepository();
  });

  it('PATCH /api/standing-instructions/:id/deactivate with a malformed id answers 404 NOT_FOUND, never a 500', async () => {
    const res = await deactivate(buildApp(repo), 'not-a-uuid');
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Standing instruction not found' });
  });

  it('a well-formed unknown id still answers the ordinary 404', async () => {
    const res = await deactivate(buildApp(repo), uuidv4());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a valid id is unaffected — the instruction is still deactivated', async () => {
    const created = await createStandingInstruction(
      {
        tenantId: TENANT,
        instruction: 'Always add a trip charge',
        source: 'settings',
        createdBy: 'user-standing-malformed',
      },
      repo,
    );

    const res = await deactivate(buildApp(repo), created.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.active).toBe(false);
  });

  it('auth ordering: a technician (no settings:update) gets 403 before any existence signal', async () => {
    const res = await deactivate(buildApp(repo, 'technician'), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await deactivate(buildApp(repo, null), 'not-a-uuid');
    expect(res.status).toBe(401);
  });
});
