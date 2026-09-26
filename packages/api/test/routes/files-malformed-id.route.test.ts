/**
 * Route hardening tests: Files (#1110, extends the #882 / #1096 sweep)
 *
 * `GET /api/files/:id` and `POST /api/files/:id/verify` pass `req.params.id`
 * straight into `PgFileRepository.findById`, whose `WHERE tenant_id = $n AND
 * id = $n` compares against a `uuid` column. A non-UUID id reached Postgres,
 * threw `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
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
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
  createFileRecord,
} from '../../src/files/file-service';
import { createFilesRouter } from '../../src/routes/files';

const TENANT = 'tenant-files-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeFileRepository extends InMemoryFileRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
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

function buildApp(repo: InMemoryFileRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-files-malformed',
        sessionId: 'sess-files-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/files',
    createFilesRouter({
      fileRepo: repo,
      storage: new FakeStorageProvider(),
      bucket: 'files-malformed-test',
      auditRepo: new InMemoryAuditRepository(),
      jobRepo: { findById: async () => null },
    }),
  );
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  { route: 'GET /api/files/:id', send: (app, id) => request(app).get(`/api/files/${id}`) },
  {
    route: 'POST /api/files/:id/verify',
    send: (app, id) => request(app).post(`/api/files/${id}/verify`).send({}),
  },
];

describe('files: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeFileRepository;

  beforeEach(() => {
    repo = new PgLikeFileRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'File not found' });
    });

    it(`${route} with a well-formed unknown id still answers the identical 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'File not found' });
    });
  }

  it('a valid id is unaffected — read and verify still answer', async () => {
    const record = await repo.create(
      createFileRecord(
        {
          tenantId: TENANT,
          uploadedBy: 'user-files-malformed',
          filename: 'note.webm',
          contentType: 'audio/webm',
          sizeBytes: 10,
        },
        'files-malformed-test',
      ),
    );
    const app = buildApp(repo);

    const read = await request(app).get(`/api/files/${record.id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(record.id);

    const verify = await request(app).post(`/api/files/${record.id}/verify`).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.reason).toBe('metadata_unavailable');
  });

  it('auth ordering: a caller whose role grants nothing gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'viewer');
    for (const { send } of HANDLERS) {
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
