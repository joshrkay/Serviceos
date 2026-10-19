/**
 * S3-1 (plan U4) — POST /api/voice/tts resolves the tenant's voice from the
 * REAL `tenant_settings.voice_id` column at real Postgres, RLS on.
 *
 *   - Tenant A stores `voice_id = 'adam'` (written by raw SQL under the
 *     tenant GUC, exactly as voice/voice-config.ts does); tenant B stores
 *     NULL. A's clip is synthesized with Adam's provider voice id, B's with
 *     the default preset's (T3: two differently configured tenants, each its
 *     own voice in one run).
 *   - A's cached clip is never served to B: the same text in B's voice is a
 *     miss and a fresh provider call.
 *   - The audit row lands in `audit_events` with `voice: 'adam'` in its
 *     metadata, and never the vendor voice id.
 *   - S3-2: POST /api/voice/tts/batch resolves the same real column: A's
 *     turn is spoken with Adam's id, B's with the default, B is never
 *     served A's bytes, and GET /api/voice/tts/clip/:hash reads A's clip
 *     back in A's voice, is a miss for B until B has spoken the line, and
 *     then gives B its own bytes.
 *
 * Seam: the real route over PgSettingsRepository + PgAuditRepository, with
 * the TTS vendor faked at the provider boundary.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts test/integration/voice-tts-voice-resolution.test.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { createVoiceRouter } from '../../src/routes/voice';
import { TtsClipCache, hashOf } from '../../src/ai/tts/clip-cache';
import type { TtsProvider } from '../../src/ai/tts/tts-provider';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Queue } from '../../src/queues/queue';

async function waitForRows<T>(query: () => Promise<{ rows: T[] }>, attempts = 40): Promise<T[]> {
  for (let i = 0; i < attempts; i += 1) {
    const { rows } = await query();
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

const ADAM = 'pNInz6obpgDQGcFmaJgB';
const RACHEL = '21m00Tcm4TlvDq8ikWAM';
const LINE = 'Tap one to hear it.';

describe('Postgres integration — S3-1/S3-2 POST /api/voice/tts and /tts/batch speak the tenant voice', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let app: express.Express;
  let acting: TestTenant;
  let adamTenant: TestTenant;
  let defaultTenant: TestTenant;
  let synthesize: ReturnType<typeof vi.fn>;

  async function seedSettings(t: TestTenant) {
    const now = new Date();
    await settingsRepo.create({
      id: randomUUID(),
      tenantId: t.tenantId,
      businessName: 'Voice Co',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** The production writer (voice/voice-config.ts) is a raw UPDATE under the tenant GUC. */
  async function storeVoiceId(t: TestTenant, voiceId: string | null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant_id = '${t.tenantId}'`);
      await client.query(`UPDATE tenant_settings SET voice_id = $1, updated_at = now() WHERE tenant_id = $2`, [
        voiceId,
        t.tenantId,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    adamTenant = await createTestTenant(pool);
    defaultTenant = await createTestTenant(pool);
    await seedSettings(adamTenant);
    await seedSettings(defaultTenant);
    await storeVoiceId(adamTenant, 'adam');
    await storeVoiceId(defaultTenant, null);
    acting = adamTenant;

    synthesize = vi.fn(async (input: { text: string; voice?: string }) => ({
      audio: Buffer.from(`mp3:${input.voice}:${input.text}`),
      contentType: 'audio/mpeg',
      provider: 'fake',
    }));
    const tts: TtsProvider = {
      synthesize,
      voiceForPreset: (preset) => preset.elevenLabsVoiceId,
    };

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: acting.userId,
        sessionId: `sess_${acting.userId}`,
        tenantId: acting.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/voice',
      createVoiceRouter(
        new InMemoryVoiceRepository(),
        { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
        undefined,
        new PgAuditRepository(pool),
        undefined,
        { tts, settingsRepo, clipCache: new TtsClipCache() },
      ),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('the stored preset key reads back through the real column', async () => {
    const { rows } = await pool.query<{ voice_id: string | null }>(
      `SELECT voice_id FROM tenant_settings WHERE tenant_id = $1`,
      [adamTenant.tenantId],
    );
    expect(rows[0].voice_id).toBe('adam');
    expect((await settingsRepo.findByTenant(adamTenant.tenantId))!.voiceId).toBe('adam');
    expect((await settingsRepo.findByTenant(defaultTenant.tenantId))!.voiceId).toBeUndefined();
  });

  it("tenant A (voice_id='adam') is spoken with Adam's id; tenant B (null) with the default preset; A's clip is not served to B (T3)", async () => {
    acting = adamTenant;
    const a = await request(app).post('/api/voice/tts').send({ text: LINE });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ cached: false, clipHash: hashOf(LINE) });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: LINE, voice: ADAM, tenantId: adamTenant.tenantId }),
    );

    acting = defaultTenant;
    const b = await request(app).post('/api/voice/tts').send({ text: LINE });
    expect(b.status).toBe(200);
    // Same text, other voice: a fresh synthesis, never Adam's bytes.
    expect(b.body).toMatchObject({ cached: false, clipHash: hashOf(LINE) });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: LINE, voice: RACHEL, tenantId: defaultTenant.tenantId }),
    );
    expect(Buffer.from(b.body.audio, 'base64').toString()).toBe(`mp3:${RACHEL}:${LINE}`);
    expect(b.body.audio).not.toBe(a.body.audio);

    // A again: a hit in A's voice.
    acting = adamTenant;
    const again = await request(app).post('/api/voice/tts').send({ text: LINE });
    expect(again.body).toMatchObject({ cached: true, clipHash: a.body.clipHash });
    expect(again.body.audio).toBe(a.body.audio);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("the audit row lands in audit_events with voice: 'adam' and never the vendor id", async () => {
    acting = adamTenant;
    const text = 'Suppose a caller tells me the water heater is leaking.';
    const res = await request(app).post('/api/voice/tts').send({ text });
    expect(res.status).toBe(200);

    // The route audits AFTER answering (failure-soft, never blocks the clip),
    // so the row may land a tick after supertest resolves: wait for it.
    const rows = await waitForRows(
      () =>
        pool.query<{ event_type: string; actor_id: string; metadata: Record<string, unknown> }>(
          `SELECT event_type, actor_id, metadata FROM audit_events
            WHERE tenant_id = $1 AND event_type = 'voice.tts.synthesized'
              AND (metadata->>'chars')::int = $2`,
          [adamTenant.tenantId, text.length],
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(adamTenant.userId);
    expect(rows[0].metadata).toMatchObject({ chars: text.length, provider: 'fake', voice: 'adam' });
    expect(JSON.stringify(rows[0].metadata)).not.toContain(ADAM);

    // Tenant B never audited a clip in Adam's voice.
    const { rows: bRows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'voice.tts.synthesized'`,
      [defaultTenant.tenantId],
    );
    expect(bRows.length).toBeGreaterThan(0);
    for (const row of bRows) expect(row.metadata.voice).toBe('rachel');
  });

  it("S3-2: the batch speaks A's turn with Adam's id from the real column, B's with the default, and the hash read follows the voice", async () => {
    const turn = [
      'How should I answer your phone?',
      'Voice Co, how can I help?',
      "Thanks for calling Voice Co. What's going on today?",
    ];

    acting = adamTenant;
    synthesize.mockClear();
    const a = await request(app).post('/api/voice/tts/batch').send({ items: turn });
    expect(a.status).toBe(200);
    expect(a.body.clips.map((c: { cached: boolean }) => c.cached)).toEqual([false, false, false]);
    expect(synthesize).toHaveBeenCalledTimes(3);
    for (const call of synthesize.mock.calls) {
      expect(call[0]).toMatchObject({ voice: ADAM, tenantId: adamTenant.tenantId });
    }

    // Before B has spoken the turn, A's hash is a miss for B: the read
    // resolves B's voice from the same column and B has no clip in it.
    const hash = a.body.clips[1].clipHash as string;
    acting = defaultTenant;
    const missB = await request(app).get(`/api/voice/tts/clip/${hash}`);
    expect(missB.status).toBe(404);
    expect(missB.body.error).toBe('NOT_CACHED');

    const b = await request(app).post('/api/voice/tts/batch').send({ items: turn });
    expect(b.status).toBe(200);
    // Same lines, other voice: three fresh clips, never Adam's bytes.
    expect(b.body.clips.map((c: { cached: boolean }) => c.cached)).toEqual([false, false, false]);
    expect(synthesize).toHaveBeenCalledTimes(6);
    for (const call of synthesize.mock.calls.slice(3)) {
      expect(call[0]).toMatchObject({ voice: RACHEL, tenantId: defaultTenant.tenantId });
    }
    for (const [i, clip] of (b.body.clips as Array<{ audio: string; clipHash: string }>).entries()) {
      expect(clip.clipHash).toBe(hashOf(turn[i]));
      expect(Buffer.from(clip.audio, 'base64').toString()).toBe(`mp3:${RACHEL}:${turn[i]}`);
      expect(clip.audio).not.toBe(a.body.clips[i].audio);
    }

    // Same hash, two voices: A reads Adam's bytes, B (now that B has spoken
    // the line) reads Rachel's, never A's. Reads never call the provider.
    acting = adamTenant;
    const readA = await request(app).get(`/api/voice/tts/clip/${hash}`).buffer(true).parse(binaryParser);
    expect(readA.status).toBe(200);
    expect(readA.headers['etag']).toBe(`"${hash}"`);
    expect((readA.body as Buffer).toString()).toBe(`mp3:${ADAM}:${turn[1]}`);
    acting = defaultTenant;
    const readB = await request(app).get(`/api/voice/tts/clip/${hash}`).buffer(true).parse(binaryParser);
    expect(readB.status).toBe(200);
    expect((readB.body as Buffer).toString()).toBe(`mp3:${RACHEL}:${turn[1]}`);
    expect(synthesize).toHaveBeenCalledTimes(6);

    // Each synthesized clip of A's turn landed as its own audit row, in A's preset.
    const rows = await waitForRows(
      () =>
        pool.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM audit_events
            WHERE tenant_id = $1 AND event_type = 'voice.tts.synthesized'
              AND (metadata->>'chars')::int = ANY($2::int[])`,
          [adamTenant.tenantId, turn.map((t) => t.length)],
        ),
      40,
    );
    expect(rows.map((r) => r.metadata.chars).sort()).toEqual(turn.map((t) => t.length).sort());
    for (const row of rows) {
      expect(row.metadata).toMatchObject({ provider: 'fake', voice: 'adam' });
      expect(JSON.stringify(row.metadata)).not.toContain(ADAM);
    }
  });
});

/** supertest parses only text/JSON by default; audio bytes need a buffer parser. */
function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
