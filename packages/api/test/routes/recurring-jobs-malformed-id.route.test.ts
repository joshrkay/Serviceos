/**
 * Route hardening tests: Recurring jobs (#1110, extends the #882 / #1096 sweep)
 *
 * Every `:id` handler on `/api/recurring-jobs` passes `req.params.id` into
 * `PgRecurringJobRepository.findById` / `archive`, whose
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
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryRecurringJobRepository } from '../../src/recurring-jobs/recurring-job';
import { createRecurringJobRouter } from '../../src/routes/recurring-jobs';

const TENANT = 'tenant-recurring-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeRecurringJobRepository extends InMemoryRecurringJobRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async archive(tenantId: string, id: string) {
    castUuid(id);
    return super.archive(tenantId, id);
  }
}

function buildApp(repo: InMemoryRecurringJobRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-recurring-malformed',
        sessionId: 'sess-recurring-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/recurring-jobs',
    createRecurringJobRouter(
      repo,
      new InMemoryAuditRepository(),
      {
        jobRepo: new InMemoryJobRepository(),
        appointmentRepo: new InMemoryAppointmentRepository(),
        locationRepo: new InMemoryLocationRepository(),
        resolveTimezone: async () => 'UTC',
      },
      new InMemoryCustomerRepository(),
    ),
  );
  return app;
}

async function seedSeries(repo: InMemoryRecurringJobRepository, isArchived = false): Promise<string> {
  const id = uuidv4();
  await repo.create({
    id,
    tenantId: TENANT,
    customerId: uuidv4(),
    title: 'Quarterly filter change',
    anchorDate: '2026-01-05',
    anchorTime: '09:00',
    durationMinutes: 60,
    appointmentType: null,
    rule: { frequency: 'monthly', interval: 3 },
    notes: null,
    isArchived,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send; technicianAllowed: boolean }> = [
  {
    route: 'GET /api/recurring-jobs/:id',
    send: (app, id) => request(app).get(`/api/recurring-jobs/${id}`),
    technicianAllowed: true,
  },
  {
    route: 'GET /api/recurring-jobs/:id/occurrences',
    send: (app, id) => request(app).get(`/api/recurring-jobs/${id}/occurrences`),
    technicianAllowed: true,
  },
  {
    route: 'PATCH /api/recurring-jobs/:id',
    send: (app, id) => request(app).patch(`/api/recurring-jobs/${id}`).send({ title: 'Renamed' }),
    technicianAllowed: true,
  },
  {
    route: 'POST /api/recurring-jobs/:id/archive',
    send: (app, id) => request(app).post(`/api/recurring-jobs/${id}/archive`).send({}),
    technicianAllowed: true,
  },
  {
    route: 'POST /api/recurring-jobs/:id/generate',
    send: (app, id) => request(app).post(`/api/recurring-jobs/${id}/generate`).send({}),
    technicianAllowed: false,
  },
];

describe('recurring jobs: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeRecurringJobRepository;

  beforeEach(() => {
    repo = new PgLikeRecurringJobRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Recurring job not found' });
    });

    it(`${route} with a well-formed unknown id still answers the ordinary 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });
  }

  it('a valid id is unaffected — read, occurrences, rename and archive still apply', async () => {
    const id = await seedSeries(repo);
    const app = buildApp(repo);

    const read = await request(app).get(`/api/recurring-jobs/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);

    const occurrences = await request(app).get(`/api/recurring-jobs/${id}/occurrences?from=2026-01-01&limit=2`);
    expect(occurrences.status).toBe(200);
    expect(occurrences.body.occurrences).toHaveLength(2);

    const renamed = await request(app).patch(`/api/recurring-jobs/${id}`).send({ title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('Renamed');

    const archived = await request(app).post(`/api/recurring-jobs/${id}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.isArchived).toBe(true);
  });

  it('a valid id is unaffected — generate still reaches the handler (stopped series answers 409)', async () => {
    const id = await seedSeries(repo, true);
    const res = await request(buildApp(repo)).post(`/api/recurring-jobs/${id}/generate`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ARCHIVED');
  });

  it('auth ordering: a technician (no jobs:create) gets 403 on generate before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { send } of HANDLERS.filter((h) => !h.technicianAllowed)) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(repo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(401);
    }
  });
});
