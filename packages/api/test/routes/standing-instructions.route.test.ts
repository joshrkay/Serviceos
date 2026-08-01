import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createStandingInstructionRouter } from '../../src/routes/standing-instructions';
import {
  InMemoryStandingInstructionRepository,
  MAX_ACTIVE_STANDING_INSTRUCTIONS,
} from '../../src/instructions/standing-instructions';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const AUTH = { userId: 'user-1', tenantId: 'tenant-1', role: 'owner' as const };

function buildApp(
  repo: InMemoryStandingInstructionRepository,
  auditRepo: InMemoryAuditRepository
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { auth: typeof AUTH }).auth = AUTH;
    next();
  });
  app.use('/api/standing-instructions', createStandingInstructionRouter(repo, auditRepo));
  return app;
}

describe('standing-instructions route (UB-A1)', () => {
  let repo: InMemoryStandingInstructionRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: Express;

  beforeEach(() => {
    repo = new InMemoryStandingInstructionRepository();
    auditRepo = new InMemoryAuditRepository();
    app = buildApp(repo, auditRepo);
  });

  it('POST creates an instruction with source settings and emits an audit event', async () => {
    const res = await request(app)
      .post('/api/standing-instructions')
      .send({ instruction: 'Always add a fuel surcharge', scope: { intents: ['create_estimate'] } });

    expect(res.status).toBe(201);
    expect(res.body.instruction).toBe('Always add a fuel surcharge');
    expect(res.body.source).toBe('settings');
    expect(res.body.active).toBe(true);
    expect(res.body.createdBy).toBe('user-1');
    expect(res.body.scope).toEqual({ intents: ['create_estimate'] });

    expect(await repo.findById('tenant-1', res.body.id)).not.toBeNull();
    const audits = auditRepo.getAll();
    expect(
      audits.some(
        (a) => a.eventType === 'standing_instruction.created' && a.entityId === res.body.id
      )
    ).toBe(true);
  });

  it.each([
    ['empty instruction', { instruction: '' }],
    ['missing instruction', {}],
    ['over-long instruction', { instruction: 'x'.repeat(501) }],
    ['negative amountCents', { instruction: 'ok', scope: { amountCents: -100 } }],
    ['float amountCents', { instruction: 'ok', scope: { amountCents: 10.5 } }],
    ['unknown segment', { instruction: 'ok', scope: { customerSegment: 'vip' } }],
    ['unknown scope key', { instruction: 'ok', scope: { discount: 10 } }],
  ])('POST rejects %s with 400', async (_label, body) => {
    const res = await request(app).post('/api/standing-instructions').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('POST rejects the 21st active instruction with 422', async () => {
    for (let i = 0; i < MAX_ACTIVE_STANDING_INSTRUCTIONS; i++) {
      const res = await request(app)
        .post('/api/standing-instructions')
        .send({ instruction: `Rule ${i}` });
      expect(res.status).toBe(201);
    }

    const overflow = await request(app)
      .post('/api/standing-instructions')
      .send({ instruction: 'One too many' });
    expect(overflow.status).toBe(422);
    expect(overflow.body.error).toBe('STANDING_INSTRUCTION_LIMIT');

    // Deactivating one frees a slot again.
    const victim = (await repo.listActive('tenant-1'))[0];
    await request(app).patch(`/api/standing-instructions/${victim.id}/deactivate`).send();
    const retry = await request(app)
      .post('/api/standing-instructions')
      .send({ instruction: 'Fits now' });
    expect(retry.status).toBe(201);
  });

  it('PATCH /:id/deactivate soft-deactivates and emits an audit event', async () => {
    const created = await request(app)
      .post('/api/standing-instructions')
      .send({ instruction: 'No weekend discounts' });

    const res = await request(app)
      .patch(`/api/standing-instructions/${created.body.id}/deactivate`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.deactivatedBy).toBe('user-1');
    expect(res.body.deactivatedAt).toBeTruthy();

    const audits = auditRepo.getAll();
    expect(
      audits.some(
        (a) =>
          a.eventType === 'standing_instruction.deactivated' && a.entityId === created.body.id
      )
    ).toBe(true);
  });

  it('PATCH /:id/deactivate returns 404 for an unknown id', async () => {
    const res = await request(app)
      .patch('/api/standing-instructions/00000000-0000-0000-0000-000000000000/deactivate')
      .send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('GET lists all by default and only active with ?active=true', async () => {
    const first = await request(app)
      .post('/api/standing-instructions')
      .send({ instruction: 'Rule A' });
    await request(app).post('/api/standing-instructions').send({ instruction: 'Rule B' });
    await request(app)
      .patch(`/api/standing-instructions/${first.body.id}/deactivate`)
      .send();

    const all = await request(app).get('/api/standing-instructions');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);

    const active = await request(app).get('/api/standing-instructions?active=true');
    expect(active.status).toBe(200);
    expect(active.body).toHaveLength(1);
    expect(active.body[0].instruction).toBe('Rule B');
  });
});
