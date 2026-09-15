/**
 * WS21a — PUT/DELETE /api/settings/voice-approval-pin.
 *
 * Proves: a 4–6 digit PIN enrolls (204, hash stored, raw PIN + hash never
 * echoed), re-enrolling changes the hash and clears the deprecated plaintext,
 * short/long PINs 400, GET redacts the credential and reports enrollment via a
 * boolean, and DELETE removes it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemorySettingsRepository,
  createSettings,
} from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { hashVoiceApprovalPin } from '../../src/settings/voice-approval-pin';

const tenantId = 't-pin';

describe('WS21a — voice-approval PIN enrollment route', () => {
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  const prevKey = process.env.TENANT_ENCRYPTION_KEY;

  beforeEach(async () => {
    process.env.TENANT_ENCRYPTION_KEY = 'unit-test-enc-key';
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 'session-1',
        tenantId,
        role: 'owner',
      };
      next();
    });
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    await createSettings({ tenantId, businessName: 'PIN Co' }, settingsRepo);
    app.use('/api/settings', createSettingsRouter(settingsRepo, undefined, auditRepo));
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = prevKey;
  });

  it('enrolls a 4-digit PIN: 204, hash stored, raw PIN never persisted or echoed', async () => {
    const res = await request(app)
      .put('/api/settings/voice-approval-pin')
      .send({ pin: '4271' });

    expect(res.status).toBe(204);
    expect(res.text).toBe(''); // no body — never echoes

    const stored = await settingsRepo.findByTenant(tenantId);
    const hash = stored!.escalationSettings!.voice_approval_pin_hash;
    expect(hash).toBe(hashVoiceApprovalPin('4271', tenantId, 'unit-test-enc-key'));
    expect(hash).not.toContain('4271');
    // Plaintext legacy field is never written by the enrollment path.
    expect(stored!.escalationSettings!.voice_approval_challenge).toBeUndefined();

    // Audit records enrollment happened — never the PIN or its hash.
    const events = await auditRepo.findRecentByTenant(tenantId);
    const ev = events.find((e) => e.eventType === 'settings.voice_approval_pin.set');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev!.metadata)).not.toContain('4271');
    expect(JSON.stringify(ev!.metadata)).not.toContain(hash);
  });

  it('accepts spaces/dashes and 5–6 digit PINs', async () => {
    const res = await request(app)
      .put('/api/settings/voice-approval-pin')
      .send({ pin: '4-2-7-1-0' });
    expect(res.status).toBe(204);
    const stored = await settingsRepo.findByTenant(tenantId);
    expect(stored!.escalationSettings!.voice_approval_pin_hash).toBe(
      hashVoiceApprovalPin('42710', tenantId, 'unit-test-enc-key'),
    );
  });

  it('re-enrolling changes the hash and clears any deprecated plaintext', async () => {
    // Seed a legacy plaintext challenge to prove it gets cleared.
    await settingsRepo.update(tenantId, {
      escalationSettings: { voice_approval_challenge: '0000' } as never,
    });
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const first = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(first.voice_approval_challenge).toBeUndefined();

    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '5382' });
    const second = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(second.voice_approval_pin_hash).not.toBe(first.voice_approval_pin_hash);
    expect(second.voice_approval_pin_hash).toBe(
      hashVoiceApprovalPin('5382', tenantId, 'unit-test-enc-key'),
    );
  });

  it('rejects a too-short PIN with 400', async () => {
    const res = await request(app)
      .put('/api/settings/voice-approval-pin')
      .send({ pin: '427' });
    expect(res.status).toBe(400);
    const stored = await settingsRepo.findByTenant(tenantId);
    expect(stored!.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
  });

  it('rejects a too-long PIN with 400', async () => {
    const res = await request(app)
      .put('/api/settings/voice-approval-pin')
      .send({ pin: '4271098' });
    expect(res.status).toBe(400);
  });

  it('GET /api/settings redacts the hash and reports enrollment via a boolean', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.voiceApprovalPinEnrolled).toBe(true);
    expect(res.body.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
    expect(res.body.escalationSettings?.voice_approval_challenge).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('4271');
  });

  it('GET reports not-enrolled before any PIN is set', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body.voiceApprovalPinEnrolled).toBe(false);
  });

  it('DELETE removes the PIN and reports not-enrolled', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const del = await request(app).delete('/api/settings/voice-approval-pin');
    expect(del.status).toBe(204);
    const stored = await settingsRepo.findByTenant(tenantId);
    expect(stored!.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
    const res = await request(app).get('/api/settings');
    expect(res.body.voiceApprovalPinEnrolled).toBe(false);
  });

  it('refuses enrollment when no server encryption key is configured', async () => {
    delete process.env.TENANT_ENCRYPTION_KEY;
    delete process.env.WEBHOOK_SIGNING_SECRET;
    const res = await request(app)
      .put('/api/settings/voice-approval-pin')
      .send({ pin: '4271' });
    expect(res.status).toBe(400);
  });

  // ── #1051 follow-up — weak-PIN rejection + the PIN-change stamp ──────────
  it.each([
    ['1111', 'repeated_digits'],
    ['0000', 'repeated_digits'],
    ['1234', 'sequence'],
    ['4321', 'sequence'],
    ['0123', 'sequence'],
    ['123456', 'sequence'],
    ['1212', 'common'],
    ['2580', 'common'],
    ['6969', 'common'],
    ['1004', 'common'],
    ['2000', 'common'],
  ])('rejects the weak PIN %s (%s) with a clear 400 and stores nothing', async (pin, reason) => {
    const res = await request(app).put('/api/settings/voice-approval-pin').send({ pin });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/too easy to guess/i);
    expect(res.body.details).toMatchObject({ field: 'pin', reason });
    expect(JSON.stringify(res.body)).not.toContain(pin);
    const stored = await settingsRepo.findByTenant(tenantId);
    expect(stored!.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
    const events = await auditRepo.findRecentByTenant(tenantId);
    expect(events.find((e) => e.eventType === 'settings.voice_approval_pin.set')).toBeUndefined();
  });

  it('a weak PIN typed with separators is still rejected (normalized first)', async () => {
    const res = await request(app).put('/api/settings/voice-approval-pin').send({ pin: '1-2-3-4' });
    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({ reason: 'sequence' });
  });

  it('a weak PIN cannot replace an enrolled one — the old PIN stays', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const before = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    const res = await request(app).put('/api/settings/voice-approval-pin').send({ pin: '1111' });
    expect(res.status).toBe(400);
    const after = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(after.voice_approval_pin_hash).toBe(before.voice_approval_pin_hash);
    expect(after.voice_approval_pin_changed_at).toBe(before.voice_approval_pin_changed_at);
  });

  it('setting and changing the PIN stamps voice_approval_pin_changed_at (the tenant strike count resets from it)', async () => {
    const t0 = Date.now();
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const first = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(typeof first.voice_approval_pin_changed_at).toBe('string');
    const firstAt = new Date(first.voice_approval_pin_changed_at!).getTime();
    expect(firstAt).toBeGreaterThanOrEqual(t0);
    expect(firstAt).toBeLessThanOrEqual(Date.now());

    await new Promise((r) => setTimeout(r, 5));
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '5382' });
    const second = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(new Date(second.voice_approval_pin_changed_at!).getTime()).toBeGreaterThan(firstAt);
  });

  it('clearing the PIN stamps voice_approval_pin_changed_at too', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const set = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    await new Promise((r) => setTimeout(r, 5));
    await request(app).delete('/api/settings/voice-approval-pin');
    const cleared = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(cleared.voice_approval_pin_hash).toBeUndefined();
    expect(new Date(cleared.voice_approval_pin_changed_at!).getTime()).toBeGreaterThan(
      new Date(set.voice_approval_pin_changed_at!).getTime(),
    );
  });

  // ── #1233 review — the generic settings PUT is not a PIN path ────────────
  it('GET /api/settings does not expose voice_approval_pin_changed_at', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.voiceApprovalPinEnrolled).toBe(true);
    expect(res.body.escalationSettings).toBeDefined();
    expect(res.body.escalationSettings.voice_approval_pin_changed_at).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('voice_approval_pin_changed_at');
  });

  it('the generic PUT /api/settings cannot set a plaintext PIN — a weak "1234" is not enrolled that way', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ escalationSettings: { channel_sms: false, voice_approval_challenge: '1234' } });
    expect(res.status).toBe(200);
    const stored = (await settingsRepo.findByTenant(tenantId))!.escalationSettings ?? {};
    expect(stored.voice_approval_challenge).toBeUndefined();
    expect(stored.channel_sms).toBe(false);
    const got = await request(app).get('/api/settings');
    expect(got.body.voiceApprovalPinEnrolled).toBe(false);
  });

  it('the generic PUT /api/settings never drops an enrolled PIN or its change stamp, and cannot overwrite them', async () => {
    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '4271' });
    const before = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;

    const res = await request(app)
      .put('/api/settings')
      .send({
        escalationSettings: {
          channel_sms: false,
          voice_approval_challenge: '1234',
          voice_approval_pin_hash: 'deadbeef',
          voice_approval_pin_changed_at: '2099-01-01T00:00:00.000Z',
        },
      });
    expect(res.status).toBe(200);

    const after = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(after.channel_sms).toBe(false);
    expect(after.voice_approval_pin_hash).toBe(before.voice_approval_pin_hash);
    expect(after.voice_approval_pin_changed_at).toBe(before.voice_approval_pin_changed_at);
    expect(after.voice_approval_challenge).toBeUndefined();
  });

  it('the generic PUT keeps a legacy tenant’s existing plaintext challenge (never silently un-enrolls it)', async () => {
    await settingsRepo.update(tenantId, {
      escalationSettings: { voice_approval_challenge: '5830' } as never,
    });
    const res = await request(app).put('/api/settings').send({ escalationSettings: { channel_whisper: false } });
    expect(res.status).toBe(200);
    const after = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(after.voice_approval_challenge).toBe('5830');
    expect(after.channel_whisper).toBe(false);
  });
});
