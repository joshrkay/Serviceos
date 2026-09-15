/**
 * Route hardening tests: Voice recordings (#1110, extends the #882 / #1096 sweep)
 *
 * `GET /api/voice/recordings/:id`, `GET /api/voice/recordings/:id/audio` and
 * `POST /api/voice/recordings/:id/retry` pass `req.params.id` into
 * `PgVoiceRepository.findById`, whose `WHERE tenant_id = $n AND id = $n`
 * compares against `voice_recordings.id uuid`. A non-UUID id reached Postgres,
 * threw `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * The #1096 sweep found this route "probably vulnerable" but masked by the
 * synthetic `rec-1` fixtures in test/compliance/recording-purge-download.test.ts;
 * those fixtures now use real uuids (production recording ids always are).
 *
 * The PgLike subclass throws exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Queue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository, TranscriptionStatus } from '../../src/voice/voice-service';

const TENANT = uuidv4();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeVoiceRepository extends InMemoryVoiceRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string },
  ) {
    castUuid(id);
    return super.updateStatus(tenantId, id, status, result);
  }
}

function buildApp(repo: InMemoryVoiceRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-voice-malformed',
        sessionId: 'sess-voice-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  const queue = { send: vi.fn(async () => 'queued-1') } as unknown as Queue;
  app.use('/api/voice', createVoiceRouter(repo, queue));
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  {
    route: 'GET /api/voice/recordings/:id',
    send: (app, id) => request(app).get(`/api/voice/recordings/${id}`),
  },
  {
    route: 'GET /api/voice/recordings/:id/audio',
    send: (app, id) => request(app).get(`/api/voice/recordings/${id}/audio`),
  },
  {
    route: 'POST /api/voice/recordings/:id/retry',
    send: (app, id) =>
      request(app)
        .post(`/api/voice/recordings/${id}/retry`)
        .send({ audioUrl: 'https://s3.test/rec/CA-1.mp3' }),
  },
];

describe('voice recordings: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeVoiceRepository;

  beforeEach(() => {
    repo = new PgLikeVoiceRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Voice recording not found' });
    });

    it(`${route} with a well-formed unknown id still answers the identical 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Voice recording not found' });
    });
  }

  it('a valid id is unaffected — read, audio (501 unconfigured) and retry still reach the handler', async () => {
    const id = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      callSid: 'CA-1',
      status: 'failed',
      createdBy: 'twilio-recording-webhook',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(repo);

    const read = await request(app).get(`/api/voice/recordings/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);

    // No fileRepo/storage wired: the handler's own capability answer, reached
    // only after the id lookup succeeds.
    const audio = await request(app).get(`/api/voice/recordings/${id}/audio`);
    expect(audio.status).toBe(501);

    const retry = await request(app)
      .post(`/api/voice/recordings/${id}/retry`)
      .send({ audioUrl: 'https://s3.test/rec/CA-1.mp3' });
    expect(retry.status).toBe(202);
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
