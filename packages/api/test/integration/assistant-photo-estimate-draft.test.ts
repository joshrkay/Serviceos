/**
 * #1173 — row 7.1's photo leg, part 2: the Assistant's draft-estimate path had
 * no image input.
 *
 * PR #1172 (#1144) made the Assistant upload a chat photo and carry
 * `attachments: [{ fileId }]` on `POST /api/assistant/chat`, but nothing
 * consumed it: `EstimateTaskHandler` (the chat draft_estimate handler) built a
 * text-only model request, and the only vision estimate path
 * (`MmsEstimateTaskHandler`) was wired to inbound MMS alone. A photo that
 * reached the chat turn could not inform the draft.
 *
 * Proven at REAL Postgres through the REAL `createAssistantRouter`: real
 * `files` rows (PgFileRepository — the tenant-scoped lookup is the T1 seam),
 * real proposals + audit_events rows, and the PRODUCTION hermetic gateway
 * (`createHermeticMockLLMGateway` — the real `LLMGateway`, including its
 * vision-capable-model failfast, over the recording `MockLLMProvider`), so the
 * assertion is on the model request the gateway actually dispatched.
 *
 * Tenant grade: T1 — tenant A's chat naming tenant B's fileId is refused
 * (no image part, no draft), and tenant B's file and proposals are untouched.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=… npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/assistant-photo-estimate-draft.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import { createHermeticMockLLMGateway } from '../../src/ai/gateway/factory';
import type { LLMRequest } from '../../src/ai/gateway/gateway';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgFileRepository } from '../../src/files/pg-file';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { createFileRecord } from '../../src/files/file-service';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const BUCKET = 'rivet-1173-test';
/** The Assistant's own photo-turn prompt (AssistantPage.tsx). */
const PHOTO_PROMPT = "Here's the photo — can you identify the issue?";

interface TenantSeed {
  tenantId: string;
  userId: string;
  fileId: string;
  photoUrl: string;
}

describe('#1173 — a chat photo reaches the draft estimate as an image part (real Postgres)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let fileRepo: PgFileRepository;
  let customerRepo: PgCustomerRepository;
  const storage = new DevStorageProvider({ bucket: BUCKET, publicUrlBase: 'http://127.0.0.1:3997/storage-dev' });
  let tenantA: TenantSeed;
  let tenantB: TenantSeed;

  async function seedTenant(customerName: string): Promise<TenantSeed> {
    const t = await createTestTenant(pool);
    const [firstName, lastName] = customerName.split(' ');
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      firstName: firstName!,
      lastName: lastName!,
      displayName: customerName,
      primaryPhone: `+1512555${crypto.randomInt(1000, 9999)}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The row POST /api/files/upload-url leaves behind for an Assistant photo.
    const record = createFileRecord(
      {
        tenantId: t.tenantId,
        filename: 'leak-under-sink.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 48_213,
        entityType: 'assistant_chat_photo',
        uploadedBy: t.userId,
      },
      BUCKET,
    );
    await fileRepo.create(record);
    return {
      tenantId: t.tenantId,
      userId: t.userId,
      fileId: record.id,
      photoUrl: await storage.generateDownloadUrl(record.storageBucket, record.storageKey),
    };
  }

  function buildApp(seed: TenantSeed) {
    const { gateway, provider } = createHermeticMockLLMGateway();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seed.userId,
        sessionId: 'sess-1173-int',
        tenantId: seed.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway,
        proposalRepo,
        auditRepo,
        customerRepo,
        entityResolver: new PgEntityResolver(pool),
        // Production wiring (app.ts): the files repo + object storage the
        // photo was uploaded through.
        photoAttachments: { fileRepo, storage },
      }),
    );
    return { app, provider };
  }

  /** Every image part on the draft_estimate request(s) the gateway dispatched. */
  function draftImageParts(calls: LLMRequest[]): Array<{ type: string; url?: string }> {
    return calls
      .filter((c) => c.taskType === 'draft_estimate')
      .flatMap((c) => c.messages)
      .flatMap((m) => (Array.isArray(m.parts) ? m.parts : []))
      .filter((p) => p.type === 'image') as Array<{ type: string; url?: string }>;
  }

  async function proposalsFor(tenantId: string) {
    const { rows } = await pool.query<{
      id: string;
      proposal_type: string;
      status: string;
      source_context: Record<string, unknown> | null;
      line_description: string | null;
    }>(
      `SELECT id, proposal_type, status, source_context,
              payload->'lineItems'->0->>'description' AS line_description
         FROM proposals WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    fileRepo = new PgFileRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    setSupervisorPresenceLoader(async () => true);
    tenantA = await seedTenant('Dana Photo');
    tenantB = await seedTenant('Jordan Neighbour');
  });

  afterAll(async () => {
    _resetSupervisorPresenceCache();
    await closeSharedTestDb();
  });

  it('a dictated draft carrying a photo: the draft_estimate model request carries the tenant-scoped signed image part, and the draft proposal + its audit row persist', async () => {
    const { app, provider } = buildApp(tenantA);

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: 'Draft an estimate for Dana Photo: fix what is in the photo' }],
        attachments: [{ fileId: tenantA.fileId }],
      });
    expect(res.status).toBe(200);
    expect(res.body.message?.proposal).toBeTruthy();

    // The photo reached the model — as an image part, at its signed URL.
    expect(draftImageParts(provider.getCalls())).toEqual([
      expect.objectContaining({ type: 'image', url: tenantA.photoUrl }),
    ]);

    const rows = (await proposalsFor(tenantA.tenantId)).filter((r) => r.proposal_type === 'draft_estimate');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_context?.photoFileIds).toEqual([tenantA.fileId]);
    // The photo-informed draft satisfies the draft_estimate payload contract.
    expect(rows[0]!.source_context?.payloadContractErrors).toBeUndefined();

    const audit = await pool.query<{ entity_id: string; metadata: Record<string, unknown> }>(
      `SELECT entity_id, metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'assistant.photo_estimate_drafted'`,
      [tenantA.tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.entity_id).toBe(rows[0]!.id);
    expect(audit.rows[0]!.metadata.fileIds).toEqual([tenantA.fileId]);
  });

  it("the Assistant's photo-only turn (\"Here's the photo — can you identify the issue?\") drafts an estimate FROM the photo", async () => {
    const { app, provider } = buildApp(tenantA);
    const before = (await proposalsFor(tenantA.tenantId)).length;

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: PHOTO_PROMPT }],
        attachments: [{ fileId: tenantA.fileId }],
      });
    expect(res.status).toBe(200);
    expect(res.body.message?.proposal).toBeTruthy();

    expect(draftImageParts(provider.getCalls())).toEqual([
      expect.objectContaining({ type: 'image', url: tenantA.photoUrl }),
    ]);
    const rows = await proposalsFor(tenantA.tenantId);
    expect(rows).toHaveLength(before + 1);
    const drafted = rows.at(-1)!;
    expect(drafted.proposal_type).toBe('draft_estimate');
    expect(drafted.source_context?.photoFileIds).toEqual([tenantA.fileId]);
    // Photo-sourced drafts never auto-approve on a hermetic (uncatalogued) price.
    expect(drafted.status).not.toBe('approved');
  });

  it('#1201 item 2 — a multi-step ("X, then Y") turn carrying a photo drafts its estimate step FROM the photo (image part, photoFileIds, audit)', async () => {
    const { app, provider } = buildApp(tenantA);
    const before = await proposalsFor(tenantA.tenantId);

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: 'Draft an estimate for Dana Photo: fix what is in the photo, then schedule it Tuesday at 9am',
          },
        ],
        attachments: [{ fileId: tenantA.fileId }],
      });
    expect(res.status).toBe(200);

    expect(draftImageParts(provider.getCalls())).toEqual([
      expect.objectContaining({ type: 'image', url: tenantA.photoUrl }),
    ]);
    const beforeIds = new Set(before.map((r) => r.id));
    const drafted = (await proposalsFor(tenantA.tenantId)).filter(
      (r) => !beforeIds.has(r.id) && r.proposal_type === 'draft_estimate',
    );
    expect(drafted).toHaveLength(1);
    expect(drafted[0]!.source_context?.photoFileIds).toEqual([tenantA.fileId]);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'assistant.photo_estimate_drafted' AND entity_id = $2`,
      [tenantA.tenantId, drafted[0]!.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata.fileIds).toEqual([tenantA.fileId]);
  });

  it('#1201 item 2 — an API turn with BLANK text and a photo drafts from the photo instead of skipping the photo path', async () => {
    const { app, provider } = buildApp(tenantA);
    const before = await proposalsFor(tenantA.tenantId);

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: '   ' }],
        attachments: [{ fileId: tenantA.fileId }],
      });
    expect(res.status).toBe(200);

    expect(draftImageParts(provider.getCalls())).toEqual([
      expect.objectContaining({ type: 'image', url: tenantA.photoUrl }),
    ]);
    const beforeIds = new Set(before.map((r) => r.id));
    const drafted = (await proposalsFor(tenantA.tenantId)).filter((r) => !beforeIds.has(r.id));
    expect(drafted.map((r) => r.proposal_type)).toEqual(['draft_estimate']);
    expect(drafted[0]!.source_context?.photoFileIds).toEqual([tenantA.fileId]);
  });

  it("T1: tenant A's chat naming TENANT B's fileId is refused — no image part, no draft — and tenant B's file and proposals are untouched", async () => {
    const { app, provider } = buildApp(tenantA);
    const aBefore = (await proposalsFor(tenantA.tenantId)).length;
    const bBefore = await proposalsFor(tenantB.tenantId);
    const bFileBefore = await pool.query(`SELECT * FROM files WHERE id = $1`, [tenantB.fileId]);

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: PHOTO_PROMPT }],
        attachments: [{ fileId: tenantB.fileId }],
      });
    expect(res.status).toBe(200);
    expect(res.body.message?.proposal).toBeFalsy();
    expect(String(res.body.message?.content)).toMatch(/couldn.t open that photo/i);

    // Nothing of B's reached the model.
    expect(draftImageParts(provider.getCalls())).toEqual([]);
    expect(JSON.stringify(provider.getCalls())).not.toContain(tenantB.photoUrl);

    expect(await proposalsFor(tenantA.tenantId)).toHaveLength(aBefore);
    expect(await proposalsFor(tenantB.tenantId)).toEqual(bBefore);
    expect((await pool.query(`SELECT * FROM files WHERE id = $1`, [tenantB.fileId])).rows).toEqual(
      bFileBefore.rows,
    );
  });
});
