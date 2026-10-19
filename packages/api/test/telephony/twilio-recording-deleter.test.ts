/**
 * PRIV-2 — the Twilio-hosted copy of a call recording is deleted once our own
 * storage holds it, and again (as a retry) by the retention sweep.
 *
 * Seams under test:
 *   - `TwilioRecordingApiDeleter` (fetch mocked): the DELETE is built from the
 *     recording's own URL, so a subaccount recording is deleted under that
 *     subaccount; a 404 means the copy is already gone; a URL that is not a
 *     Twilio recording is refused before any credential is sent; the auth
 *     token never appears in a thrown message.
 *   - `deleteTwilioCopy` (deleter + state store mocked): stamps and audits a
 *     deletion once, records a failed attempt for the retry, never throws and
 *     never logs the token.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TwilioRecordingApiDeleter,
  deleteTwilioCopy,
  twilioRecordingResourceUrl,
  TWILIO_COPY_DELETED_EVENT,
  type TwilioCopyStateStore,
  type TwilioRecordingDeleter,
} from '../../src/telephony/twilio-recording-deleter';
import type { AuditEvent } from '../../src/audit/audit';

const MASTER_SID = 'AC' + 'a'.repeat(32);
const AUTH_TOKEN = 'super-secret-twilio-token';
const SUB_SID = 'AC' + 'b'.repeat(32);
const RECORDING_SID = 'RE' + 'c'.repeat(32);
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function response(status: number, body = ''): Response {
  return new Response(status === 204 ? null : body, { status });
}

describe('twilioRecordingResourceUrl', () => {
  it('builds the recording resource under the account named in the recording URL (subaccounts)', () => {
    expect(twilioRecordingResourceUrl(RECORDING_URL)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}.json`,
    );
  });

  it('accepts the media-suffixed form Twilio also hands out', () => {
    expect(twilioRecordingResourceUrl(`${RECORDING_URL}.mp3`)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}.json`,
    );
  });

  it('refuses anything that is not a Twilio recording URL', () => {
    for (const url of [
      'https://api.twilio.com/2010-04-01/Recordings/RE-happy',
      `https://evil.example/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}`,
      `http://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}`,
      `https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Calls/CA1/Recordings/${RECORDING_SID}`,
      `https://api.twilio.com.evil.example/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}`,
      'not a url',
      '',
    ]) {
      expect(twilioRecordingResourceUrl(url)).toBeNull();
    }
  });
});

describe('TwilioRecordingApiDeleter.deleteRecording', () => {
  it('sends an authenticated DELETE for the recording resource and reports it deleted on 204', async () => {
    const fetchImpl = vi.fn(async () => response(204));
    const deleter = new TwilioRecordingApiDeleter(MASTER_SID, AUTH_TOKEN, fetchImpl as unknown as typeof fetch);

    await expect(deleter.deleteRecording(RECORDING_URL)).resolves.toBe('deleted');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Recordings/${RECORDING_SID}.json`);
    expect(init.method).toBe('DELETE');
    const basic = Buffer.from(`${MASTER_SID}:${AUTH_TOKEN}`).toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${basic}`);
  });

  it('treats 404 as already deleted', async () => {
    const fetchImpl = vi.fn(async () => response(404, '{"code":20404}'));
    const deleter = new TwilioRecordingApiDeleter(MASTER_SID, AUTH_TOKEN, fetchImpl as unknown as typeof fetch);

    await expect(deleter.deleteRecording(RECORDING_URL)).resolves.toBe('already_gone');
  });

  it('throws on any other answer, with the status and without the token', async () => {
    const fetchImpl = vi.fn(async () => response(401, `{"message":"bad ${AUTH_TOKEN}"}`));
    const deleter = new TwilioRecordingApiDeleter(MASTER_SID, AUTH_TOKEN, fetchImpl as unknown as typeof fetch);

    const err = (await deleter.deleteRecording(RECORDING_URL).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(AUTH_TOKEN);
  });

  it('a transport error never carries the token or the basic credential out', async () => {
    const basic = Buffer.from(`${MASTER_SID}:${AUTH_TOKEN}`).toString('base64');
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed for Basic ${basic} token=${AUTH_TOKEN}`);
    });
    const deleter = new TwilioRecordingApiDeleter(MASTER_SID, AUTH_TOKEN, fetchImpl as unknown as typeof fetch);

    const err = (await deleter.deleteRecording(RECORDING_URL).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(AUTH_TOKEN);
    expect(err.message).not.toContain(basic);
  });

  it('refuses a URL that is not a Twilio recording without sending the credentials anywhere', async () => {
    const fetchImpl = vi.fn(async () => response(204));
    const deleter = new TwilioRecordingApiDeleter(MASTER_SID, AUTH_TOKEN, fetchImpl as unknown as typeof fetch);

    await expect(deleter.deleteRecording('https://evil.example/steal')).rejects.toThrow(/not a Twilio recording/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function stateStore(stamped = true) {
  return {
    markTwilioCopyDeleted: vi.fn(async () => stamped),
    markTwilioCopyDeleteFailed: vi.fn(async () => undefined),
  } satisfies TwilioCopyStateStore;
}

function auditSpy() {
  return { create: vi.fn(async (event: AuditEvent) => event) };
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

const NOW = new Date('2026-10-19T12:00:00Z');
const REC = {
  tenantId: TENANT_ID,
  voiceRecordingId: 'vr-1',
  callSid: 'CA1',
  recordingUrl: RECORDING_URL,
};

describe('deleteTwilioCopy', () => {
  it('deletes, stamps and audits the deletion once', async () => {
    const deleter: TwilioRecordingDeleter = { deleteRecording: vi.fn(async () => 'deleted' as const) };
    const repo = stateStore();
    const auditRepo = auditSpy();

    const ok = await deleteTwilioCopy(
      { deleter, repo, auditRepo, logger: logger(), now: () => NOW },
      REC,
      { actorId: 'recording_webhook', reason: 'stored_in_own_storage' },
    );

    expect(ok).toBe(true);
    expect(deleter.deleteRecording).toHaveBeenCalledWith(RECORDING_URL);
    expect(repo.markTwilioCopyDeleted).toHaveBeenCalledWith(TENANT_ID, 'vr-1', NOW);
    expect(repo.markTwilioCopyDeleteFailed).not.toHaveBeenCalled();
    expect(auditRepo.create).toHaveBeenCalledOnce();
    expect(auditRepo.create.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_ID,
      actorId: 'recording_webhook',
      actorRole: 'system',
      eventType: TWILIO_COPY_DELETED_EVENT,
      entityType: 'voice_recording',
      entityId: 'vr-1',
      metadata: { callSid: 'CA1', reason: 'stored_in_own_storage', alreadyGone: false },
    });
  });

  it('a copy already gone (404) is stamped as deleted', async () => {
    const deleter: TwilioRecordingDeleter = { deleteRecording: vi.fn(async () => 'already_gone' as const) };
    const repo = stateStore();
    const auditRepo = auditSpy();

    const ok = await deleteTwilioCopy(
      { deleter, repo, auditRepo, logger: logger(), now: () => NOW },
      REC,
      { actorId: 'recording-retention-worker', reason: 'retry' },
    );

    expect(ok).toBe(true);
    expect(repo.markTwilioCopyDeleted).toHaveBeenCalledOnce();
    expect(auditRepo.create.mock.calls[0][0]).toMatchObject({ metadata: { alreadyGone: true } });
  });

  it('a row someone else already stamped is not audited twice', async () => {
    const deleter: TwilioRecordingDeleter = { deleteRecording: vi.fn(async () => 'already_gone' as const) };
    const auditRepo = auditSpy();

    const ok = await deleteTwilioCopy(
      { deleter, repo: stateStore(false), auditRepo, logger: logger(), now: () => NOW },
      REC,
      { actorId: 'recording_webhook', reason: 'stored_in_own_storage' },
    );

    expect(ok).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('a failed delete records the attempt for the retry, logs without the token, and never throws', async () => {
    const real = new TwilioRecordingApiDeleter(
      MASTER_SID,
      AUTH_TOKEN,
      (async () => response(500, `{"message":"${AUTH_TOKEN}"}`)) as unknown as typeof fetch,
    );
    const repo = stateStore();
    const log = logger();
    const auditRepo = auditSpy();

    const ok = await deleteTwilioCopy(
      { deleter: real, repo, auditRepo, logger: log, now: () => NOW },
      REC,
      { actorId: 'recording_webhook', reason: 'stored_in_own_storage' },
    );

    expect(ok).toBe(false);
    expect(repo.markTwilioCopyDeleted).not.toHaveBeenCalled();
    expect(repo.markTwilioCopyDeleteFailed).toHaveBeenCalledWith(TENANT_ID, 'vr-1', NOW);
    expect(auditRepo.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain(AUTH_TOKEN);
  });

  it('a failed stamp after a successful delete is logged and reported as not confirmed (the retry re-stamps on 404)', async () => {
    const deleter: TwilioRecordingDeleter = { deleteRecording: vi.fn(async () => 'deleted' as const) };
    const repo = stateStore();
    repo.markTwilioCopyDeleted.mockRejectedValueOnce(new Error('db down'));
    const log = logger();

    const ok = await deleteTwilioCopy(
      { deleter, repo, logger: log, now: () => NOW },
      REC,
      { actorId: 'recording_webhook', reason: 'stored_in_own_storage' },
    );

    expect(ok).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});
