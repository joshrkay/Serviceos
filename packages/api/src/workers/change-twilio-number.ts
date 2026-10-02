import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { QueueMessage } from '../queues/queue';
import { decrypt } from '../integrations/crypto';
import {
  attachNumberToMessagingService,
  listSubaccountPhoneNumbers,
  purchasePhoneNumber,
  releasePhoneNumber,
} from '../integrations/twilio/provisioning';
import type { VapiClient } from '../integrations/vapi/client';
import { isTwilioTestNumber } from '../telephony/phone-policy';
import { tenantQuery } from './tenant-query';

/**
 * #1563 — Settings → Phone "change number", run by the provisioning worker
 * (under its per-tenant lock) for a `changeTo` job.
 *
 * Order is the safety property: buy new → attach to the Messaging Service →
 * repoint the tenant (provider_data phoneE164/phoneNumberSid, which inbound
 * voice/SMS routing resolves the tenant from) → release old. Any failure
 * BEFORE the repoint hands the new number back and leaves the tenant on its
 * current line, so a change can never leave the tenant with zero numbers.
 * Releasing the old number is best-effort AFTER the repoint: if it fails the
 * tenant briefly owns two numbers (recorded for ops), never zero.
 *
 * Every outcome clears `pendingChange`; an unsuccessful one records an
 * owner-readable `changeError` (Settings → Phone shows it).
 */
export async function changeTenantNumber(input: {
  pool: Pool;
  tenantId: string;
  changeTo: string;
  voiceBaseUrl: string;
  encKey: string;
  vapi: VapiClient | null | undefined;
  message: QueueMessage<unknown>;
  logger: Logger;
}): Promise<void> {
  const { pool, tenantId, changeTo, voiceBaseUrl, encKey, vapi, message, logger } = input;

  const finish = async (changeError: string | null, extra: Record<string, unknown> = {}) => {
    await tenantQuery(
      pool,
      tenantId,
      `UPDATE tenant_integrations
       SET provider_data = (provider_data - 'pendingChange' - 'changeError') || $1::jsonb,
           updated_at = NOW()
       WHERE tenant_id = $2 AND provider = 'twilio'`,
      [JSON.stringify({ ...extra, ...(changeError ? { changeError } : {}) }), tenantId],
    );
  };

  const { rows } = await tenantQuery<{
    status: string;
    subaccount_sid: string | null;
    auth_token_primary_enc: string | null;
    provider_data: {
      messagingServiceSid?: string;
      phoneNumberSid?: string;
      phoneE164?: string;
      vapiPhoneNumberId?: string;
    } | null;
  }>(
    pool,
    tenantId,
    `SELECT status, subaccount_sid, auth_token_primary_enc, provider_data
     FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
    [tenantId],
  );
  const row = rows[0];
  const pd = row?.provider_data ?? {};
  if (
    !row ||
    row.status !== 'full_readiness' ||
    !row.subaccount_sid ||
    !row.auth_token_primary_enc ||
    !pd.messagingServiceSid ||
    !pd.phoneNumberSid
  ) {
    await finish("Your line isn't fully set up yet, so we kept your current number.");
    return;
  }
  if (pd.phoneE164 === changeTo) {
    await finish(null);
    return;
  }

  const subaccountSid = row.subaccount_sid;
  const authToken = decrypt(row.auth_token_primary_enc, encKey);
  const oldSid = pd.phoneNumberSid;
  const oldE164 = pd.phoneE164 ?? null;

  // 1 — buy the new number. A crash after a previous attempt's purchase
  // leaves it on the subaccount; reuse it instead of buying it twice.
  let newSid: string;
  try {
    const owned = await listSubaccountPhoneNumbers(subaccountSid, authToken);
    const already = owned.find((n) => n.phoneNumber === changeTo);
    if (already) {
      newSid = already.sid;
    } else {
      const bought = await purchasePhoneNumber(
        subaccountSid,
        authToken,
        null,
        `${voiceBaseUrl}/api/telephony/voice`,
        `${voiceBaseUrl}/webhooks/twilio/status/${tenantId}`,
        changeTo,
      );
      newSid = bought.sid;
      if (isTwilioTestNumber(bought.phoneNumber)) {
        await releasePhoneNumber(subaccountSid, authToken, newSid).catch(() => undefined);
        await finish(
          'Twilio returned a test number (the configured credentials look like TEST credentials), so we kept your current number.',
        );
        return;
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const status = Number(errMsg.match(/→\s*(\d{3}):/)?.[1] ?? 0);
    if (status >= 400 && status < 500 && status !== 429) {
      await finish(`${changeTo} is no longer available, so we kept your current number. Pick another one.`);
      return;
    }
    // Transient (429 / 5xx / network): let the queue retry — but on the last
    // attempt, tell the owner instead of leaving "switching…" up forever.
    if (message.attempts >= message.maxAttempts) {
      await finish(`We couldn't reach our phone provider, so we kept your current number. Try again in a few minutes.`);
    }
    throw err;
  }

  // 2 + 3 — attach, then repoint. Failure here rolls the new number back.
  try {
    await attachNumberToMessagingService(subaccountSid, authToken, pd.messagingServiceSid, newSid);
    await tenantQuery(
      pool,
      tenantId,
      `UPDATE tenant_integrations
       SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
       WHERE tenant_id = $2 AND provider = 'twilio'`,
      [JSON.stringify({ phoneNumberSid: newSid, phoneE164: changeTo, numberAttached: true }), tenantId],
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Change number failed before repoint — rolling back the new number', {
      tenantId,
      newSid,
      error: reason,
    });
    let released = true;
    try {
      await releasePhoneNumber(subaccountSid, authToken, newSid);
    } catch (releaseErr) {
      released = false;
      logger.error('Rollback release of the new number FAILED — orphaned on the subaccount', {
        tenantId,
        newSid,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    await finish(
      `We couldn't switch to ${changeTo}, so we kept your current number.`,
      released ? {} : { orphanedNumberSid: newSid },
    );
    return;
  }

  // The worker stamps business_phone with the line it provisioned; follow the
  // change only when it still points at the old number (never clobber a
  // business line the owner typed in).
  if (oldE164) {
    await tenantQuery(
      pool,
      tenantId,
      `UPDATE tenant_settings SET business_phone = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND business_phone = $3`,
      [changeTo, tenantId, oldE164],
    );
  }

  // Vapi (off by default): link the new number to the existing assistant,
  // then (#1575) delete the previous number's Vapi phone-number resource —
  // nothing routes to it once the tenant is repointed, and the old Twilio
  // number is released below. Best-effort, exactly like first provisioning:
  // a Vapi failure never affects the Twilio line.
  if (vapi) {
    const oldVapiId = pd.vapiPhoneNumberId ?? null;
    let currentVapiId: string | null = oldVapiId;
    try {
      const cfg = await tenantQuery<{ vapi_assistant_id: string | null }>(
        pool,
        tenantId,
        `SELECT vapi_assistant_id FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const assistantId = cfg.rows[0]?.vapi_assistant_id;
      if (assistantId) {
        const linked = await vapi.linkPhoneNumber({ assistantId, phoneE164: changeTo, twilioPhoneNumberSid: newSid });
        currentVapiId = linked.phoneNumberId;
      }
    } catch (vapiErr) {
      logger.error('Vapi relink after number change failed (Twilio line unaffected)', {
        tenantId,
        error: vapiErr instanceof Error ? vapiErr.message : String(vapiErr),
      });
    }
    if (oldVapiId) {
      try {
        await vapi.deletePhoneNumber(oldVapiId);
        if (currentVapiId === oldVapiId) currentVapiId = null;
      } catch (vapiErr) {
        // The stale resource only references a number we are releasing, so
        // it cannot route a call; log the id so ops can delete it by hand.
        logger.error('Deleting the previous Vapi phone number after a change FAILED — delete it by hand', {
          tenantId,
          vapiPhoneNumberId: oldVapiId,
          error: vapiErr instanceof Error ? vapiErr.message : String(vapiErr),
        });
      }
    }
    if (currentVapiId !== oldVapiId) {
      await tenantQuery(
        pool,
        tenantId,
        `UPDATE tenant_integrations
         SET provider_data = (provider_data - 'vapiPhoneNumberId') || $1::jsonb, updated_at = NOW()
         WHERE tenant_id = $2 AND provider = 'twilio'`,
        [JSON.stringify(currentVapiId ? { vapiPhoneNumberId: currentVapiId } : {}), tenantId],
      );
    }
  }

  // 4 — release the old number, now that nothing routes to it.
  let orphan: Record<string, unknown> = {};
  try {
    await releasePhoneNumber(subaccountSid, authToken, oldSid);
  } catch (releaseErr) {
    logger.error('Releasing the previous number after a change FAILED — release it by hand', {
      tenantId,
      oldSid,
      error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
    });
    orphan = { orphanedNumberSid: oldSid };
  }
  await finish(null, orphan);
  logger.info('Tenant number changed', { tenantId, from: oldE164, to: changeTo });
}
