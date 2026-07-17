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

    await request(app).put('/api/settings/voice-approval-pin').send({ pin: '9999' });
    const second = (await settingsRepo.findByTenant(tenantId))!.escalationSettings!;
    expect(second.voice_approval_pin_hash).not.toBe(first.voice_approval_pin_hash);
    expect(second.voice_approval_pin_hash).toBe(
      hashVoiceApprovalPin('9999', tenantId, 'unit-test-enc-key'),
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
});
