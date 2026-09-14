/**
 * Route hardening tests: Job custom fields (#1110, extends the #882 / #1096 sweep)
 *
 * `POST /defs/:fieldDefId/archive`, `GET /jobs/:jobId` and
 * `PUT /jobs/:jobId/values/:fieldDefId` on `/api/job-custom-fields` pass their
 * params into `PgJobCustomFieldRepository` / `PgJobRepository`, which compare
 * them against `uuid` columns. A non-UUID value reached Postgres, threw
 * `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * The PgLike subclasses throw exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 *
 * `GET /jobs/:jobId` is list-shaped: a well-formed id that names no job
 * answers `200` with the tenant's definitions and null values, unchanged.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryJobCustomFieldRepository } from '../../src/jobs/job-custom-field';
import { createJobCustomFieldRouter } from '../../src/routes/job-custom-fields';

const TENANT = 'tenant-job-custom-fields-malformed';
const JOB_ID = uuidv4();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeJobCustomFieldRepository extends InMemoryJobCustomFieldRepository {
  async findDefById(tenantId: string, id: string) {
    castUuid(id);
    return super.findDefById(tenantId, id);
  }

  async archiveDef(tenantId: string, id: string) {
    castUuid(id);
    return super.archiveDef(tenantId, id);
  }

  async setValue(tenantId: string, jobId: string, fieldDefId: string, value: string | null) {
    castUuid(jobId);
    castUuid(fieldDefId);
    return super.setValue(tenantId, jobId, fieldDefId, value);
  }

  async listValues(tenantId: string, jobId: string) {
    castUuid(jobId);
    return super.listValues(tenantId, jobId);
  }
}

/** Only the tenant/id lookup matters to these routes; one known job exists. */
class PgLikeJobRepository extends InMemoryJobRepository {
  async findById(tenantId: string, id: string): Promise<Job | null> {
    castUuid(id);
    return tenantId === TENANT && id === JOB_ID ? ({ id, tenantId } as Job) : null;
  }
}

function buildApp(repo: InMemoryJobCustomFieldRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-job-custom-fields-malformed',
        sessionId: 'sess-job-custom-fields-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/job-custom-fields',
    createJobCustomFieldRouter(repo, new InMemoryAuditRepository(), new PgLikeJobRepository()),
  );
  return app;
}

async function seedDef(repo: InMemoryJobCustomFieldRepository): Promise<string> {
  const id = uuidv4();
  await repo.createDef({
    id,
    tenantId: TENANT,
    key: 'panel_model',
    label: 'Panel model',
    fieldType: 'text',
    options: [],
    sortOrder: 0,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

type Send = (app: Express, bad: string) => request.Test;

const JOB = 'Job not found';
const FIELD = 'Job custom field not found';

const HANDLERS: Array<{ route: string; message: string; send: Send; unknownStatus: number }> = [
  {
    route: 'POST /api/job-custom-fields/defs/:fieldDefId/archive',
    message: FIELD,
    send: (app, bad) => request(app).post(`/api/job-custom-fields/defs/${bad}/archive`).send({}),
    unknownStatus: 404,
  },
  {
    route: 'GET /api/job-custom-fields/jobs/:jobId',
    message: JOB,
    send: (app, bad) => request(app).get(`/api/job-custom-fields/jobs/${bad}`),
    unknownStatus: 200,
  },
  {
    route: 'PUT /api/job-custom-fields/jobs/:jobId/values/:fieldDefId (malformed :jobId)',
    message: JOB,
    send: (app, bad) =>
      request(app).put(`/api/job-custom-fields/jobs/${bad}/values/${uuidv4()}`).send({ value: 'x' }),
    unknownStatus: 404,
  },
  {
    route: 'PUT /api/job-custom-fields/jobs/:jobId/values/:fieldDefId (malformed :fieldDefId)',
    message: FIELD,
    send: (app, bad) =>
      request(app).put(`/api/job-custom-fields/jobs/${JOB_ID}/values/${bad}`).send({ value: 'x' }),
    unknownStatus: 404,
  },
];

describe('job custom fields: malformed :jobId / :fieldDefId never reach Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeJobCustomFieldRepository;

  beforeEach(() => {
    repo = new PgLikeJobCustomFieldRepository();
  });

  for (const { route, message, send, unknownStatus } of HANDLERS) {
    it(`${route} with a malformed value answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message });
    });

    it(`${route} with a well-formed unknown value keeps its existing ${unknownStatus} answer`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(unknownStatus);
    });
  }

  it('a valid id is unaffected — set, read back and archive still apply', async () => {
    const defId = await seedDef(repo);
    const app = buildApp(repo);

    const set = await request(app)
      .put(`/api/job-custom-fields/jobs/${JOB_ID}/values/${defId}`)
      .send({ value: 'Square D QO' });
    expect(set.status).toBe(200);

    const read = await request(app).get(`/api/job-custom-fields/jobs/${JOB_ID}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([expect.objectContaining({ fieldDefId: defId, value: 'Square D QO' })]);

    const archived = await request(app).post(`/api/job-custom-fields/defs/${defId}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.isArchived).toBe(true);
  });

  it('auth ordering: a technician (no settings:update) gets 403 on the def archive before any existence signal', async () => {
    const res = await HANDLERS[0].send(buildApp(repo, 'technician'), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(repo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(401);
    }
  });
});
