// #1564 — async worker (P0-009 pattern) that advances a tenant's US A2P 10DLC
// registration and polls Twilio until the campaign is approved or rejected.
//
// Each run: load the registration, decrypt the EIN in memory, advance the
// state machine as far as Twilio allows (checkpointing every created SID),
// then — unless terminal — re-enqueue itself with a delay. Brand vetting and
// campaign review take days, so polling is coarse (hours, not seconds).
//
// The EIN never reaches a log line: only status / SIDs are logged.

import type { Pool } from 'pg';
import type { WorkerHandler, QueueMessage, Queue } from '../queues/queue';
import type { Logger } from '../logging/logger';
import { decrypt } from '../integrations/crypto';
import {
  advanceA2pRegistration,
  type A2pIsvConfig,
  type A2pRegistrationProgress,
} from '../integrations/twilio/a2p-10dlc/registration';
import {
  TwilioApiError,
  type TwilioA2pClient,
  type TwilioCreds,
} from '../integrations/twilio/a2p-10dlc/twilio-a2p-client';
import type { A2pRegistrationStore } from '../integrations/twilio/a2p-10dlc/store';
import {
  A2P_REGISTRATION_JOB_TYPE,
  type A2pRegistrationJobPayload,
} from '../integrations/twilio/a2p-10dlc/service';
import { tenantQuery } from './tenant-query';

/** Six hours: TCR brand + campaign review is measured in business days. */
export const DEFAULT_A2P_POLL_DELAY_SECONDS = 6 * 60 * 60;

export interface TenantMessaging {
  creds: TwilioCreds;
  messagingServiceSid: string | null;
}

export function createA2pRegistrationWorker(deps: {
  store: A2pRegistrationStore;
  queue: Queue;
  client: TwilioA2pClient;
  encryptionKey: string;
  /** Rivet's ISV config; null when the platform has not been set up yet. */
  isv: A2pIsvConfig | null;
  /** The tenant's Twilio subaccount creds + Messaging Service, or null. */
  resolveTenantMessaging: (tenantId: string) => Promise<TenantMessaging | null>;
  /** Mirror of the status onto the phone integration (optional). */
  onProgress?: (tenantId: string, progress: A2pRegistrationProgress) => Promise<void>;
  pollDelaySeconds?: number;
}): WorkerHandler<A2pRegistrationJobPayload> {
  const pollDelaySeconds = deps.pollDelaySeconds ?? DEFAULT_A2P_POLL_DELAY_SECONDS;

  return {
    type: A2P_REGISTRATION_JOB_TYPE,

    async handle(message: QueueMessage<A2pRegistrationJobPayload>, logger: Logger): Promise<void> {
      const { tenantId, poll } = message.payload;
      const record = await deps.store.get(tenantId);
      if (!record) {
        logger.warn('A2P registration job for a tenant with no registration', { tenantId });
        return;
      }
      const startStatus = record.progress.status;
      if (startStatus === 'approved' || startStatus === 'failed') return;

      const scheduleNextPoll = async () => {
        const payload: A2pRegistrationJobPayload = { tenantId, poll: poll + 1 };
        await deps.queue.send(
          A2P_REGISTRATION_JOB_TYPE,
          payload,
          `a2p-10dlc-${tenantId}-${record.submittedAt.getTime()}-${poll + 1}`,
          { delaySeconds: pollDelaySeconds },
        );
      };

      const messaging = await deps.resolveTenantMessaging(tenantId);
      if (!deps.isv || !messaging) {
        logger.warn('A2P registration waiting — ISV config or tenant Twilio subaccount not available yet', {
          tenantId,
          isvConfigured: deps.isv !== null,
          subaccountReady: messaging !== null,
        });
        await scheduleNextPoll();
        return;
      }

      const ein = decrypt(record.einEnc, deps.encryptionKey);
      let lastSaved = record.progress;
      let progress: A2pRegistrationProgress;
      try {
        progress = await advanceA2pRegistration({
          progress: record.progress,
          details: { ...record.details, ein },
          creds: messaging.creds,
          messagingServiceSid: messaging.messagingServiceSid,
          isv: deps.isv,
          client: deps.client,
          checkpoint: async (p) => {
            lastSaved = p;
            await deps.store.saveProgress(tenantId, p);
          },
        });
      } catch (err) {
        // 429 / 5xx / network: rethrow so the queue retries this message;
        // the checkpoints already persisted every SID created so far.
        if (!(err instanceof TwilioApiError) || err.retriable) throw err;
        // Any other 4xx is Twilio refusing the details themselves — retrying
        // cannot fix it. Fail with Twilio's reason so the owner can correct
        // and resubmit. Log only status/code: Twilio's text can echo a
        // submitted value, so it is never logged.
        logger.warn('A2P registration refused by Twilio', { tenantId, status: err.status, code: err.code ?? null });
        progress = {
          ...lastSaved,
          status: 'failed',
          failureReasons: [redact(err.detail, ein) || `Twilio rejected the registration (error ${err.code ?? err.status}).`],
        };
      }
      await deps.store.saveProgress(tenantId, progress);
      if (deps.onProgress) await deps.onProgress(tenantId, progress);

      logger.info('A2P registration advanced', {
        tenantId,
        from: startStatus,
        to: progress.status,
        brandSid: progress.refs.brandSid ?? null,
        campaignSid: progress.refs.campaignSid ?? null,
      });

      if (progress.status !== 'approved' && progress.status !== 'failed') {
        await scheduleNextPoll();
      }
    },
  };
}

/** Masks the EIN if Twilio's error text echoes it back. */
function redact(text: string, ein: string): string {
  return ein ? text.split(ein).join('•••••••••').trim() : text.trim();
}

/**
 * Production resolver: the tenant's Twilio subaccount creds (auth token
 * decrypted with TENANT_ENCRYPTION_KEY) and Messaging Service from
 * tenant_integrations. Null when there is no real subaccount yet — including
 * the non-production stub integration, which has none.
 */
export function createPgTenantMessagingResolver(
  pool: Pool,
  encryptionKey: string,
): (tenantId: string) => Promise<TenantMessaging | null> {
  return async (tenantId) => {
    const { rows } = await tenantQuery<{
      subaccount_sid: string | null;
      auth_token_primary_enc: string | null;
      provider_data: { messagingServiceSid?: string } | null;
    }>(
      pool,
      tenantId,
      `SELECT subaccount_sid, auth_token_primary_enc, provider_data
         FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId],
    );
    const row = rows[0];
    if (!row?.subaccount_sid || !row.auth_token_primary_enc) return null;
    return {
      creds: { accountSid: row.subaccount_sid, authToken: decrypt(row.auth_token_primary_enc, encryptionKey) },
      messagingServiceSid: row.provider_data?.messagingServiceSid ?? null,
    };
  };
}

/**
 * Mirrors the registration status into the phone integration's provider_data
 * (`a2p10dlc`) so anything reading the integration sees it. Deliberately does
 * NOT change tenant_integrations.status: voice + the onboarding phone step key
 * off 'full_readiness', and outbound SMS while unregistered stays as today.
 */
export function createPgA2pIntegrationMirror(
  pool: Pool,
): (tenantId: string, progress: A2pRegistrationProgress) => Promise<void> {
  return async (tenantId, progress) => {
    const mirror = {
      a2p10dlc: {
        status: progress.status,
        brandSid: progress.refs.brandSid ?? null,
        campaignSid: progress.refs.campaignSid ?? null,
        failureReasons: progress.failureReasons,
        updatedAt: new Date().toISOString(),
      },
    };
    await tenantQuery(
      pool,
      tenantId,
      `UPDATE tenant_integrations
          SET provider_data = provider_data || $2::jsonb, updated_at = NOW()
        WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId, JSON.stringify(mirror)],
    );
  };
}
