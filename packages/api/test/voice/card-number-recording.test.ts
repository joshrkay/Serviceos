/**
 * PRIV-3 — flagCardNumberRecording: the one write that marks a recording on
 * which a card number was said, shared by the recording webhook's transcript
 * hook and the transcription worker.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import {
  CARD_NUMBER_DETECTED_EVENT,
  flagCardNumberRecording,
} from '../../src/voice/card-number-recording';

const TENANT = 'tenant-1';
const ARGS = {
  tenantId: TENANT,
  voiceRecordingId: 'rec-1',
  actorId: 'recording_webhook',
  source: 'call_transcript' as const,
};

async function seededRepo() {
  const voiceRepo = new InMemoryVoiceRepository();
  await voiceRepo.create({
    id: 'rec-1',
    tenantId: TENANT,
    status: 'completed',
    createdBy: 'twilio-recording-webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return voiceRepo;
}

describe('flagCardNumberRecording (PRIV-3)', () => {
  it('flags the recording and writes one system audit event', async () => {
    const voiceRepo = await seededRepo();
    const auditRepo = new InMemoryAuditRepository();

    await flagCardNumberRecording({ voiceRepo, auditRepo, logger: { error: vi.fn() } }, ARGS);

    expect(voiceRepo.cardNumberDetected.has('rec-1')).toBe(true);
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      eventType: CARD_NUMBER_DETECTED_EVENT,
      actorId: 'recording_webhook',
      actorRole: 'system',
      entityType: 'voice_recording',
      entityId: 'rec-1',
      metadata: { source: 'call_transcript' },
    });
  });

  it('a second flag of the same recording (webhook retry, queue redelivery) writes no second audit event', async () => {
    const voiceRepo = await seededRepo();
    const auditRepo = new InMemoryAuditRepository();
    const deps = { voiceRepo, auditRepo, logger: { error: vi.fn() } };

    await flagCardNumberRecording(deps, ARGS);
    await flagCardNumberRecording(deps, ARGS);

    expect(auditRepo.getAll()).toHaveLength(1);
  });

  it("another tenant's recording is never flagged", async () => {
    const voiceRepo = await seededRepo();
    const auditRepo = new InMemoryAuditRepository();

    await flagCardNumberRecording(
      { voiceRepo, auditRepo, logger: { error: vi.fn() } },
      { ...ARGS, tenantId: 'tenant-2' },
    );

    expect(voiceRepo.cardNumberDetected.size).toBe(0);
    expect(auditRepo.getAll()).toEqual([]);
  });

  it('a failed flag write is logged as an error and never throws', async () => {
    const error = vi.fn();
    const voiceRepo = { markCardNumberDetected: vi.fn(async () => { throw new Error('db down'); }) };

    await expect(
      flagCardNumberRecording({ voiceRepo, logger: { error } }, ARGS),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      'card number on recording: flag write failed; audio kept until the retention horizon',
      expect.objectContaining({ tenantId: TENANT, voiceRecordingId: 'rec-1', error: 'db down' }),
    );
  });
});
