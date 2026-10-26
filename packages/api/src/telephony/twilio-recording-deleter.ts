/**
 * PRIV-2 — delete the Twilio-hosted copy of a call recording.
 *
 * Every recorded call (and every voicemail) is fetched from Twilio, stored in
 * our own object storage and recorded as a `voice_recordings` row. Our copy is
 * the one the app plays, transcribes and purges at the tenant's retention
 * horizon; the copy Twilio keeps is a duplicate nothing reads. Leaving it
 * there meant call audio outlived the retention horizon and the purge record.
 *
 * Two pieces:
 *   - `TwilioRecordingApiDeleter` sends
 *       DELETE /2010-04-01/Accounts/{AccountSid}/Recordings/{RecordingSid}.json
 *     built from the recording's OWN URL, so a recording made on a tenant's
 *     subaccount is deleted under that subaccount (the platform credentials
 *     that fetched it may delete it there). A 404 means the copy is already
 *     gone. A URL that is not a Twilio recording is refused before any
 *     credential is sent.
 *   - `deleteTwilioCopy` deletes, stamps `voice_recordings.twilio_deleted_at`
 *     (migration 315) and audits `voice_recording.twilio_copy_deleted`. A
 *     failure stamps `twilio_delete_attempted_at` instead so the retention
 *     sweep retries it later; it never throws.
 *
 * Callers: the recording webhook (after the S3 PUT and the row insert), the
 * voicemail-status route (after its whole at-least-once pipeline; its
 * notify-only branch, which has no row, calls the bare deleter and audits the
 * same event), and the
 * recording-retention sweep (horizon purge, card-number audio purge, and the
 * retry phase for legacy and failed rows). `recording_url` is never nulled: it
 * is the per-recording idempotency key in `recordInboundCall`.
 *
 * Logging discipline mirrors recording-control.ts: never log the auth token
 * or the basic credential derived from it.
 */
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import { timedFetch } from '../shared/timed-fetch';

export const TWILIO_COPY_DELETED_EVENT = 'voice_recording.twilio_copy_deleted';

/** Bounds the DELETE so a slow Twilio never holds a webhook or the sweep. */
export const TWILIO_DELETE_TIMEOUT_MS = 10_000;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const RECORDING_SID = /^RE[0-9a-f]{32}$/i;

/**
 * The Twilio REST resource for a recording, from the RecordingUrl Twilio
 * handed us (`https://api.twilio.com/2010-04-01/Accounts/AC…/Recordings/RE…`,
 * optionally with a media suffix). Null for anything else.
 */
export function twilioRecordingResourceUrl(recordingUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(recordingUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com') return null;
  if (url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/');
  // ['', '2010-04-01', 'Accounts', 'AC…', 'Recordings', 'RE…[.ext]']
  if (parts.length !== 6) return null;
  const [, version, accounts, accountSid, recordings, last] = parts;
  if (version !== '2010-04-01' || accounts !== 'Accounts' || recordings !== 'Recordings') return null;
  const recordingSid = last.replace(/\.(mp3|wav|json)$/i, '');
  if (!ACCOUNT_SID.test(accountSid) || !RECORDING_SID.test(recordingSid)) return null;
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.json`;
}

export interface TwilioRecordingDeleter {
  /**
   * Delete the Twilio-hosted recording. Resolves `'deleted'`, or
   * `'already_gone'` when Twilio answers 404. Throws on anything else.
   */
  deleteRecording(recordingUrl: string): Promise<'deleted' | 'already_gone'>;
}

export class TwilioRecordingApiDeleter implements TwilioRecordingDeleter {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = timedFetch(TWILIO_DELETE_TIMEOUT_MS, fetchImpl);
  }

  async deleteRecording(recordingUrl: string): Promise<'deleted' | 'already_gone'> {
    const resource = twilioRecordingResourceUrl(recordingUrl);
    if (!resource) throw new Error('not a Twilio recording URL; nothing sent');
    const basic = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(resource, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${basic}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // No `cause` on purpose: the transport error can carry the basic
      // credential or the token, and loggers serialise the cause chain.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Twilio recording delete failed: ${this.scrub(message, basic)}`);
    }
    if (res.status === 404) return 'already_gone';
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(
        `Twilio recording delete failed ${res.status}: ${this.scrub(bodyText.slice(0, 200), basic)}`,
      );
    }
    return 'deleted';
  }

  private scrub(text: string, basic: string): string {
    return text.split(basic).join('<redacted>').split(this.authToken).join('<redacted>');
  }
}

/** Where the Twilio-copy state lives (`PgRecordingRetentionRepository`). */
export interface TwilioCopyStateStore {
  /** Stamp `twilio_deleted_at`. True only for the write that set it. */
  markTwilioCopyDeleted(tenantId: string, id: string, deletedAt: Date): Promise<boolean>;
  /** Stamp `twilio_delete_attempted_at` so the sweep retries with a back-off. */
  markTwilioCopyDeleteFailed(tenantId: string, id: string, attemptedAt: Date): Promise<void>;
}

export interface TwilioCopyRef {
  tenantId: string;
  voiceRecordingId: string;
  callSid: string | null;
  recordingUrl: string;
}

export interface DeleteTwilioCopyDeps {
  deleter: TwilioRecordingDeleter;
  repo: TwilioCopyStateStore;
  auditRepo?: Pick<AuditRepository, 'create'>;
  logger: Pick<Logger, 'warn' | 'error'>;
  now?: () => Date;
}

/**
 * `metadata.reason` on `voice_recording.twilio_copy_deleted`. `notify_only` is
 * the voicemail route's notify-only branch, which has no row: it calls the bare
 * deleter and writes the same event itself (entityId = the RecordingSid).
 */
export type TwilioCopyDeleteReason =
  | 'stored_in_own_storage'
  | 'past_retention'
  | 'card_number_detected'
  | 'retry'
  | 'notify_only';

/**
 * Delete one recording's Twilio copy, stamp it and audit it. Resolves true
 * when the copy is confirmed gone and recorded; false when it must be retried.
 * Never throws.
 */
export async function deleteTwilioCopy(
  deps: DeleteTwilioCopyDeps,
  rec: TwilioCopyRef,
  ctx: { actorId: string; reason: TwilioCopyDeleteReason },
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  let outcome: 'deleted' | 'already_gone';
  try {
    outcome = await deps.deleter.deleteRecording(rec.recordingUrl);
  } catch (err) {
    deps.logger.warn('twilio recording copy: delete failed; retried by the retention sweep', {
      tenantId: rec.tenantId,
      voiceRecordingId: rec.voiceRecordingId,
      callSid: rec.callSid,
      reason: ctx.reason,
      // The deleter's messages are already scrubbed of credentials.
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await deps.repo.markTwilioCopyDeleteFailed(rec.tenantId, rec.voiceRecordingId, now());
    } catch (stampErr) {
      deps.logger.warn('twilio recording copy: failed-attempt stamp failed', {
        tenantId: rec.tenantId,
        voiceRecordingId: rec.voiceRecordingId,
        error: stampErr instanceof Error ? stampErr.message : String(stampErr),
      });
    }
    return false;
  }

  let stamped: boolean;
  try {
    stamped = await deps.repo.markTwilioCopyDeleted(rec.tenantId, rec.voiceRecordingId, now());
  } catch (err) {
    // The copy is gone but not recorded; the sweep's retry gets a 404 and
    // stamps it then.
    deps.logger.warn('twilio recording copy: deleted, but the stamp failed; the sweep re-stamps it', {
      tenantId: rec.tenantId,
      voiceRecordingId: rec.voiceRecordingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!stamped || !deps.auditRepo) return true;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: rec.tenantId,
        actorId: ctx.actorId,
        actorRole: 'system',
        eventType: TWILIO_COPY_DELETED_EVENT,
        entityType: 'voice_recording',
        entityId: rec.voiceRecordingId,
        metadata: {
          callSid: rec.callSid,
          reason: ctx.reason,
          alreadyGone: outcome === 'already_gone',
        },
      }),
    );
  } catch (err) {
    deps.logger.warn('twilio recording copy: audit write failed', {
      tenantId: rec.tenantId,
      voiceRecordingId: rec.voiceRecordingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/**
 * What the recording webhook and the voicemail-status route call once our
 * storage and our row hold the recording. Resolves true when the copy is
 * confirmed gone; never throws.
 */
export type TwilioCopyRemover = (rec: TwilioCopyRef) => Promise<boolean>;

/** Bind the deps and the acting webhook for one ingest route (wired in app.ts). */
export function createTwilioCopyRemover(
  deps: DeleteTwilioCopyDeps,
  actorId: string,
): TwilioCopyRemover {
  return (rec) => deleteTwilioCopy(deps, rec, { actorId, reason: 'stored_in_own_storage' });
}
