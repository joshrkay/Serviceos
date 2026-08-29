/**
 * Route hardening tests: Notes (#882)
 *
 * A non-UUID `:id` used to flow straight into PgNoteRepository's uuid
 * comparison, so Postgres threw `invalid input syntax for type uuid` and the
 * route answered a bare 500. This PgLike subclass throws the same error
 * Postgres would (pattern: customers.route.test.ts, the #871 precedent).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Express, NextFunction, Request, Response } from 'express';
import { createNoteRouter } from '../../src/routes/notes';
import { InMemoryNoteRepository, type InternalNote } from '../../src/notes/note';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-notes-1';
const USER_ID = 'user-notes-1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeNoteRepository extends InMemoryNoteRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<InternalNote>) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.update(tenantId, id, updates);
  }

  async delete(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.delete(tenantId, id);
  }
}

function buildPgLikeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-notes-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  const ownership: TenantOwnership = {
    async requireExists() {},
    async requireExistsAndLoad() {
      return undefined;
    },
  };
  app.use(
    '/api/notes',
    createNoteRouter(new PgLikeNoteRepository(), ownership, new InMemoryAuditRepository()),
  );
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison (#882)', () => {
  let app: Express;

  beforeEach(() => {
    app = buildPgLikeApp();
  });

  it('PUT /api/notes/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).put('/api/notes/not-a-uuid').send({ content: 'edited' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toBe('Note not found');
  });

  it('DELETE /api/notes/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).delete('/api/notes/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a well-formed but unknown uuid still answers the ordinary 404', async () => {
    const res = await request(app)
      .put('/api/notes/11111111-1111-1111-1111-111111111111')
      .send({ content: 'edited' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
