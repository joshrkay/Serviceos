/**
 * Route hardening tests: Attachments (#1110, extends the #882 / #1096 sweep)
 *
 * `POST /api/attachments/:id/{archive,visibility,pair}` pass `req.params.id`
 * straight into `AttachmentService` → `PgAttachmentRepository`, whose
 * `WHERE tenant_id = $n AND id = $n` compares against a `uuid` column. A
 * non-UUID id therefore reached Postgres, threw
 * `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * `InMemoryAttachmentRepository` is a plain Map so it cannot reproduce that on
 * its own; the PgLike subclass below throws exactly what Postgres would (the
 * pattern from customers.route.test.ts / leads.route.test.ts /
 * users-malformed-id.route.test.ts). The real-Postgres leg for every router in
 * this sweep is test/integration/malformed-id-404-seam.test.ts.
 *
 * Expected answer: the route's own 404 NOT_FOUND envelope via
 * `notFoundOnMalformedId` (src/middleware/validate-uuid-param.ts), wired AFTER
 * requirePermission so 401/403 still answer first.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
} from '../../src/files/file-service';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import { AttachmentService } from '../../src/attachments/attachment-service';
import { createAttachmentsRouter } from '../../src/routes/attachments';

const TENANT = uuidv4();
const JOB_ID = uuidv4();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeAttachmentRepository extends InMemoryAttachmentRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async archive(tenantId: string, id: string) {
    castUuid(id);
    return super.archive(tenantId, id);
  }

  async setPortalVisibility(tenantId: string, id: string, visible: boolean) {
    castUuid(id);
    return super.setPortalVisibility(tenantId, id, visible);
  }
}

class FakeStorageProvider implements StorageProvider {
  async generateUploadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/put/${bucket}/${key}`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/get/${bucket}/${key}`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }
  async getObject(): Promise<Buffer | null> {
    return null;
  }
  async putObject(): Promise<void> {
    return;
  }
  async deleteObject(): Promise<void> {
    return;
  }
}

function buildApp(repo: InMemoryAttachmentRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-attachments-malformed',
        sessionId: 'sess-attachments-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  const storage = new FakeStorageProvider();
  const auditRepo = new InMemoryAuditRepository();
  const service = new AttachmentService(repo, new InMemoryFileRepository(), storage, auditRepo, {
    job: async (_tenantId, id) => id === JOB_ID,
    invoice: async () => false,
    estimate: async () => false,
  });
  app.use(
    '/api/attachments',
    createAttachmentsRouter({
      service,
      fileRepo: new InMemoryFileRepository(),
      storage,
      bucket: 'attachments-malformed-test',
      auditRepo,
    }),
  );
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  {
    route: 'POST /api/attachments/:id/archive',
    send: (app, id) => request(app).post(`/api/attachments/${id}/archive`).send({}),
  },
  {
    route: 'POST /api/attachments/:id/visibility',
    send: (app, id) => request(app).post(`/api/attachments/${id}/visibility`).send({ visible: true }),
  },
  {
    route: 'POST /api/attachments/:id/pair',
    send: (app, id) =>
      request(app).post(`/api/attachments/${id}/pair`).send({ otherId: uuidv4(), role: 'before' }),
  },
];

describe('attachments: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeAttachmentRepository;

  beforeEach(() => {
    repo = new PgLikeAttachmentRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Attachment not found' });
    });

    it(`${route} with a well-formed unknown id still answers the ordinary 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });
  }

  it('a valid id is unaffected — archive and visibility still apply', async () => {
    const created = await repo.create(TENANT, {
      fileId: uuidv4(),
      entityType: 'job',
      entityId: JOB_ID,
      kind: 'photo',
      uploadedBy: 'user-attachments-malformed',
    });
    const app = buildApp(repo);

    const vis = await request(app)
      .post(`/api/attachments/${created.id}/visibility`)
      .send({ visible: true });
    expect(vis.status).toBe(200);
    expect(vis.body.portalVisible).toBe(true);

    const archived = await request(app).post(`/api/attachments/${created.id}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBeTruthy();
  });

  it('auth ordering: a technician (no files:delete / attachments:visibility) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    const archive = await request(app).post('/api/attachments/not-a-uuid/archive').send({});
    expect(archive.status).toBe(403);
    expect(archive.body.error).toBe('FORBIDDEN');

    const vis = await request(app)
      .post('/api/attachments/not-a-uuid/visibility')
      .send({ visible: true });
    expect(vis.status).toBe(403);
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await request(buildApp(repo, null)).post('/api/attachments/not-a-uuid/pair').send({});
    expect(res.status).toBe(401);
  });
});
