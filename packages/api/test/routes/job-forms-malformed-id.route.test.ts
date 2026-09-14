/**
 * Route hardening tests: Job forms (#1110, extends the #882 / #1096 sweep)
 *
 * Every `:id` / `:jobId` handler on `/api/job-forms` passes the param into
 * `PgJobFormRepository` / `PgJobRepository`, which compare it against `uuid`
 * columns (`job_form_templates.id`, `job_form_submissions.id` / `job_id`,
 * `jobs.id`). A non-UUID value reached Postgres, threw
 * `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * The PgLike subclasses throw exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 *
 * `GET /jobs/:jobId/submissions` is list-shaped: a well-formed id that names
 * no job answers `200 []`, unchanged.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryJobFormRepository } from '../../src/job-forms/job-form';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { createJobFormRouter } from '../../src/routes/job-forms';

const TENANT = 'tenant-job-forms-malformed';
const JOB_ID = uuidv4();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeJobFormRepository extends InMemoryJobFormRepository {
  async findTemplateById(tenantId: string, id: string) {
    castUuid(id);
    return super.findTemplateById(tenantId, id);
  }

  async archiveTemplate(tenantId: string, id: string) {
    castUuid(id);
    return super.archiveTemplate(tenantId, id);
  }

  async findSubmissionById(tenantId: string, id: string) {
    castUuid(id);
    return super.findSubmissionById(tenantId, id);
  }

  async listSubmissionsByJob(tenantId: string, jobId: string) {
    castUuid(jobId);
    return super.listSubmissionsByJob(tenantId, jobId);
  }
}

/** Only the tenant/id lookup matters to these routes; one known job exists. */
class PgLikeJobRepository extends InMemoryJobRepository {
  async findById(tenantId: string, id: string): Promise<Job | null> {
    castUuid(id);
    return tenantId === TENANT && id === JOB_ID ? ({ id, tenantId } as Job) : null;
  }
}

function buildApp(repo: InMemoryJobFormRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-job-forms-malformed',
        sessionId: 'sess-job-forms-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/job-forms',
    createJobFormRouter(repo, new InMemoryAuditRepository(), new PgLikeJobRepository()),
  );
  return app;
}

async function seedTemplate(repo: InMemoryJobFormRepository): Promise<string> {
  const id = uuidv4();
  await repo.createTemplate({
    id,
    tenantId: TENANT,
    name: 'Pre-start checklist',
    description: null,
    fields: [
      { id: 'breaker_off', label: 'Breaker off', fieldType: 'checkbox', options: [], required: false, sortOrder: 0 },
    ],
    sortOrder: 0,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

type Send = (app: Express, bad: string) => request.Test;

const TEMPLATE = 'Job form template not found';
const SUBMISSION = 'Job form submission not found';
const JOB = 'Job not found';

const HANDLERS: Array<{ route: string; message: string; send: Send; unknownStatus: number }> = [
  {
    route: 'GET /api/job-forms/templates/:id',
    message: TEMPLATE,
    send: (app, bad) => request(app).get(`/api/job-forms/templates/${bad}`),
    unknownStatus: 404,
  },
  {
    route: 'PATCH /api/job-forms/templates/:id',
    message: TEMPLATE,
    send: (app, bad) => request(app).patch(`/api/job-forms/templates/${bad}`).send({ name: 'Renamed' }),
    unknownStatus: 404,
  },
  {
    route: 'POST /api/job-forms/templates/:id/archive',
    message: TEMPLATE,
    send: (app, bad) => request(app).post(`/api/job-forms/templates/${bad}/archive`).send({}),
    unknownStatus: 404,
  },
  {
    route: 'GET /api/job-forms/jobs/:jobId/submissions',
    message: JOB,
    send: (app, bad) => request(app).get(`/api/job-forms/jobs/${bad}/submissions`),
    unknownStatus: 200,
  },
  {
    route: 'POST /api/job-forms/jobs/:jobId/submissions',
    message: JOB,
    send: (app, bad) =>
      request(app).post(`/api/job-forms/jobs/${bad}/submissions`).send({ templateId: uuidv4() }),
    unknownStatus: 404,
  },
  {
    route: 'GET /api/job-forms/submissions/:id',
    message: SUBMISSION,
    send: (app, bad) => request(app).get(`/api/job-forms/submissions/${bad}`),
    unknownStatus: 404,
  },
  {
    route: 'PATCH /api/job-forms/submissions/:id',
    message: SUBMISSION,
    send: (app, bad) => request(app).patch(`/api/job-forms/submissions/${bad}`).send({ answers: [] }),
    unknownStatus: 404,
  },
];

describe('job forms: malformed :id / :jobId never reach Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeJobFormRepository;

  beforeEach(() => {
    repo = new PgLikeJobFormRepository();
  });

  for (const { route, message, send, unknownStatus } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message });
    });

    it(`${route} with a well-formed unknown id keeps its existing ${unknownStatus} answer`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(unknownStatus);
    });
  }

  it('a valid id is unaffected — template read/rename, submission create/read/update/list, archive still apply', async () => {
    const templateId = await seedTemplate(repo);
    const app = buildApp(repo);

    const read = await request(app).get(`/api/job-forms/templates/${templateId}`);
    expect(read.status).toBe(200);

    const renamed = await request(app).patch(`/api/job-forms/templates/${templateId}`).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed');

    const created = await request(app).post(`/api/job-forms/jobs/${JOB_ID}/submissions`).send({ templateId });
    expect(created.status).toBe(201);

    const list = await request(app).get(`/api/job-forms/jobs/${JOB_ID}/submissions`);
    expect(list.status).toBe(200);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([created.body.id]);

    const one = await request(app).get(`/api/job-forms/submissions/${created.body.id}`);
    expect(one.status).toBe(200);

    const updated = await request(app)
      .patch(`/api/job-forms/submissions/${created.body.id}`)
      .send({ answers: [{ fieldId: 'breaker_off', value: 'true' }] });
    expect(updated.status).toBe(200);

    const archived = await request(app).post(`/api/job-forms/templates/${templateId}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.isArchived).toBe(true);
  });

  it('auth ordering: a technician (no settings:update) gets 403 on template writes before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { route, send } of HANDLERS) {
      if (!/^(PATCH|POST) \/api\/job-forms\/templates/.test(route)) continue;
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
