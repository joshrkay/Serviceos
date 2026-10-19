/**
 * U7 (S6-3) — start a demo call: the visitor's number, the one start
 * transaction (allowance, lease, budget reservation, lead and `demo_calls`
 * row, S6-2), the lease token, ONE bounded `Calls` request from the platform
 * number, and what that request did settled on the rows (plan Approach,
 * "Only a `Calls` request that provably created no call releases anything
 * at once").
 *
 * Order matters and is the whole design:
 *   1. Refusals that need no database: the module closed or switched off, no
 *      platform credentials, secret or public URL, a number that is not a
 *      regular NANP number. Nothing is written.
 *   2. The start transaction commits before the request exists, so no call
 *      can exist without a committed lease and reservation.
 *   3. The token is minted from the committed lease; both callback URLs
 *      carry it, so a callback that beats the response still finds its
 *      lease (S6-6).
 *   4. The request is bounded at 10 s and never retried: a second request
 *      after an unconfirmed outcome could ring the visitor twice.
 *   5. `created` binds the CallSid and renews nothing (the call may still be
 *      queued); `not_created` returns the reservation and the allowance once
 *      (D11), releases the lease and fails the row; `unconfirmed` keeps all
 *      three and answers the visitor as for a success.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DemoCallTrade } from '@ai-service-os/shared';
import { NPA_METROS, metroForPhone } from '../compliance/us-geography';
import type { PlatformTwilioCreds } from '../integrations/credentials';
import { getPlatformTwilioCreds } from '../integrations/credentials';
import type { Logger } from '../logging/logger';
import type { AlertOperatorFn } from '../monitoring/alert-operator';
import { isNanpKey, normalizePhone } from '../shared/phone';
import { isOutboundAllowed } from '../voice/outbound-allowlist';
import { releaseNoCall } from './call-budget';
import { isDemoCallsEnabled, type DemoConfig } from './config';
import { CALLS_REQUEST_TIMEOUT_MS, RING_TIMEOUT_S, TIME_LIMIT_S, demoLeaseStep } from './lease';
import { mintLeaseToken } from './lease-token';
import { setPlatformTenantContext, writePlatformAudit } from './platform-audit';
import { runStartTransaction, type StartedDemoCall } from './start-transaction';
import { classifyCallsOutcome, type CallsOutcome, type CallsRequestResult } from './twilio-outcome';

export const DEMO_CALL_CREATED_EVENT = 'demo_call_created';
export const DEMO_CALL_FAILED_EVENT = 'demo_call_failed';
export const DEMO_CALL_UNCONFIRMED_EVENT = 'demo_call_unconfirmed';

const TWILIO_API_BASE_URL = 'https://api.twilio.com/2010-04-01';

/** The callback paths the token rides on (answered by S6-6). */
export const DEMO_VOICE_PATH = '/public/demo/voice';
export const DEMO_STATUS_PATH = '/public/demo/status';

export interface DemoCallStartFields {
  phone: string;
  trade: DemoCallTrade;
  businessName: string;
  metro?: string;
}

export interface DemoCallServiceDeps {
  /** Null in in-memory dev: the module is closed. */
  pool: Pool | null;
  /** Loaded once at boot (`loadDemoConfig`). */
  config: DemoConfig;
  /** The kill switch, read per request (default `isDemoCallsEnabled`). */
  isEnabled?: () => boolean;
  /** Default `getPlatformTwilioCreds()`, read per request. */
  getCreds?: () => PlatformTwilioCreds | null;
  /** `DEMO_LEASE_TOKEN_SECRET`; undefined closes the module. */
  leaseTokenSecret: string | undefined;
  /** The host Twilio calls back (`PUBLIC_API_URL`); undefined closes the module. */
  publicApiUrl: string | undefined;
  /** Budget-crossing pages, sent after the start transaction commits. */
  alert: AlertOperatorFn;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** The request's abort signal for a bound in ms (default `AbortSignal.timeout`). */
  timeoutSignal?: (ms: number) => AbortSignal;
  now?: () => Date;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type StartDemoCallResult =
  | { kind: 'disabled'; reason: string }
  | { kind: 'number_not_allowed'; reason: 'malformed' | 'non_nanp' | 'premium_npa' }
  | { kind: 'rate_limited' }
  | { kind: 'busy'; cause: 'pool' | 'budget' }
  | { kind: 'calling'; correlationId: string; outcome: 'created' | 'unconfirmed' }
  | { kind: 'failed'; correlationId: string };

/** The visitor's number as E.164: a bare 10-digit or 1+10-digit number is NANP. */
export function normalizeDemoPhone(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;
  const national = normalizePhone(trimmed);
  return national.length === 10 ? `+1${national}` : `+${national}`;
}

/**
 * The number as it is stored (allowance key, `demo_calls.phone_hash`, the
 * lease's `visitor_phone_hash`): HMAC-SHA256 under the lease secret, so a
 * platform table never holds a number in the clear. Rotating the secret
 * starts every number's allowance afresh.
 */
export function hashDemoPhone(e164: string, secret: string): string {
  return createHmac('sha256', secret).update(`demo_phone:${e164}`).digest('hex');
}

/** The D2 snapshot's metro: the visitor's pick when it is a known metro, else the area code's. */
export function resolveDemoMetro(
  e164: string,
  picked: string | undefined,
): { metroCode: string | null; metroName: string | null } {
  if (picked && Object.prototype.hasOwnProperty.call(NPA_METROS, picked)) {
    return { metroCode: picked, metroName: NPA_METROS[picked].name };
  }
  const found = metroForPhone(e164);
  return found.kind === 'metro' ? { metroCode: found.metroCode, metroName: found.name } : { metroCode: null, metroName: null };
}

/** A request that cannot be built is a local failure: no request is made. */
export class LocalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRequestError';
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;

export interface CallsRequestInput {
  apiBaseUrl: string;
  creds: PlatformTwilioCreds;
  publicApiUrl: string;
  toE164: string;
  leaseToken: string;
}

/**
 * The `Calls.json` request: the shape of `telephony/outbound-call-service.ts`
 * (URL, Basic auth, form body) minus the customer bridge, from the platform
 * number, with the lease token on both callback URLs, the three status
 * events that can renew or end the lease, and the ring and talk limits the
 * lease timings assume.
 */
export function buildCallsRequest(input: CallsRequestInput): {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
} {
  if (!E164.test(input.creds.fromE164)) throw new LocalRequestError('platform From number is not E.164');
  if (!E164.test(input.toE164)) throw new LocalRequestError('visitor number is not E.164');
  let base: URL;
  try {
    base = new URL(input.publicApiUrl);
  } catch {
    throw new LocalRequestError('public API URL is not absolute');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new LocalRequestError('public API URL is not http(s)');
  }
  const root = base.toString().replace(/\/+$/, '');
  const callbackUrl = (path: string) => {
    const u = new URL(`${root}${path}`);
    u.searchParams.set('lease', input.leaseToken);
    return u.toString();
  };

  const body = new URLSearchParams({
    To: input.toE164,
    From: input.creds.fromE164,
    Url: callbackUrl(DEMO_VOICE_PATH),
    Method: 'POST',
    StatusCallback: callbackUrl(DEMO_STATUS_PATH),
    StatusCallbackMethod: 'POST',
  });
  // Twilio's default is `completed` alone; a live event is what renews the
  // lease (S6-6), so ask for the three explicitly (repeated parameter).
  for (const event of ['ringing', 'answered', 'completed']) body.append('StatusCallbackEvent', event);
  body.set('Timeout', String(RING_TIMEOUT_S));
  body.set('TimeLimit', String(TIME_LIMIT_S));

  const auth = Buffer.from(`${input.creds.accountSid}:${input.creds.authToken}`).toString('base64');
  return {
    url: `${input.apiBaseUrl.replace(/\/+$/, '')}/Accounts/${encodeURIComponent(input.creds.accountSid)}/Calls.json`,
    init: {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  };
}

interface OpenGate {
  pool: Pool;
  creds: PlatformTwilioCreds;
  secret: string;
  publicApiUrl: string;
}

/**
 * The refusals that need neither the body nor the database: the module
 * closed or switched off, no platform credentials, secret, public URL or
 * database. Returns the refusal, or what an open module runs on.
 */
export function demoCallGate(deps: DemoCallServiceDeps): { kind: 'disabled'; reason: string } | { kind: 'open'; gate: OpenGate } {
  if (!deps.config.open) return { kind: 'disabled', reason: deps.config.reason };
  if (!(deps.isEnabled ?? isDemoCallsEnabled)()) return { kind: 'disabled', reason: 'DEMO_CALLS_ENABLED is off' };
  const creds = (deps.getCreds ?? (() => getPlatformTwilioCreds()))();
  if (!creds) return { kind: 'disabled', reason: 'PLATFORM_TWILIO_* is not set' };
  if (!deps.leaseTokenSecret) return { kind: 'disabled', reason: 'DEMO_LEASE_TOKEN_SECRET is not set' };
  if (!deps.publicApiUrl) return { kind: 'disabled', reason: 'PUBLIC_API_URL is not set' };
  if (!deps.pool) return { kind: 'disabled', reason: 'no database' };
  return {
    kind: 'open',
    gate: { pool: deps.pool, creds, secret: deps.leaseTokenSecret, publicApiUrl: deps.publicApiUrl },
  };
}

export async function startDemoCall(fields: DemoCallStartFields, deps: DemoCallServiceDeps): Promise<StartDemoCallResult> {
  // (1) Refusals that need no database.
  const opened = demoCallGate(deps);
  if (opened.kind === 'disabled') return opened;
  const { pool, creds, secret, publicApiUrl } = opened.gate;

  const e164 = normalizeDemoPhone(fields.phone);
  const allowed = isOutboundAllowed(e164);
  if (!allowed.allowed) return { kind: 'number_not_allowed', reason: allowed.reason ?? 'malformed' };
  if (!isNanpKey(e164.slice(2))) return { kind: 'number_not_allowed', reason: 'malformed' };

  // (2) The start transaction.
  const correlationId = randomBytes(16).toString('base64url');
  const metro = resolveDemoMetro(e164, fields.metro);
  const started = await runStartTransaction(
    pool,
    {
      phoneHash: hashDemoPhone(e164, secret),
      e164,
      trade: fields.trade,
      businessName: fields.businessName,
      metroCode: metro.metroCode,
      metroName: metro.metroName,
      correlationId,
    },
    demoLeaseStep,
    { config: deps.config, isEnabled: deps.isEnabled, alert: deps.alert, now: deps.now },
  );
  if (started.kind !== 'started') return started;
  const call = started.call;

  // (3) + (4) The token, then one bounded request.
  const result = await placeCall(call, e164, creds, secret, publicApiUrl, deps);
  const outcome = classifyCallsOutcome(result);

  // (5) Settle. A failure here leaves the row `initiating`, which every
  // later sweep reads as unconfirmed: nothing is released on a guess.
  try {
    await settle(pool, call, outcome);
  } catch (err) {
    deps.logger?.error('demo call: settling the Calls outcome failed; row left initiating', {
      demoCallId: call.demoCallId,
      outcome: outcome.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (outcome.outcome === 'not_created') {
    deps.logger?.warn('demo call: Calls request created no call', { demoCallId: call.demoCallId, reason: outcome.reason });
    return { kind: 'failed', correlationId };
  }
  if (outcome.outcome === 'unconfirmed') {
    deps.logger?.warn('demo call: Calls outcome unconfirmed', { demoCallId: call.demoCallId, reason: outcome.reason });
  }
  return { kind: 'calling', correlationId, outcome: outcome.outcome };
}

async function placeCall(
  call: StartedDemoCall,
  toE164: string,
  creds: PlatformTwilioCreds,
  secret: string,
  publicApiUrl: string,
  deps: DemoCallServiceDeps,
): Promise<CallsRequestResult> {
  let request: ReturnType<typeof buildCallsRequest>;
  try {
    const leaseToken = mintLeaseToken(
      {
        leaseId: call.leaseId,
        tenantId: call.tenantId,
        gen: call.leaseGeneration,
        sexp: call.callbackDeadlineAt.getTime(),
      },
      secret,
    );
    request = buildCallsRequest({
      apiBaseUrl: deps.apiBaseUrl ?? TWILIO_API_BASE_URL,
      creds,
      publicApiUrl,
      toE164,
      leaseToken,
    });
  } catch (error) {
    return { kind: 'local_failure', error };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const signal = (deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms)))(CALLS_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal });
  } catch (error) {
    return { kind: 'thrown', error };
  }
  let bodyText: string | null;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = null;
  }
  return { kind: 'response', status: response.status, bodyText };
}

async function inPlatformTransaction(pool: Pool, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (err: Error) => {
    broken = err;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await setPlatformTenantContext(client);
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((e: unknown) => {
      broken ??= e instanceof Error ? e : new Error(String(e));
    });
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

async function settle(pool: Pool, call: StartedDemoCall, outcome: CallsOutcome): Promise<void> {
  await inPlatformTransaction(pool, async (client) => {
    switch (outcome.outcome) {
      case 'created': {
        // Bind, renew nothing: a 2xx says Twilio accepted the request, not
        // that the call is live. S6-6 replaces this with the bind-and-renew
        // statement every callback shares.
        const lease = await client.query(
          `UPDATE demo_tenant_leases SET call_sid = $2 WHERE id = $1 AND call_sid IS NULL`,
          [call.leaseId, outcome.callSid],
        );
        await client.query(
          `UPDATE demo_calls
              SET call_sid = $2,
                  status = CASE WHEN status = 'initiating' THEN 'queued' ELSE status END,
                  updated_at = now()
            WHERE id = $1 AND call_sid IS NULL`,
          [call.demoCallId, outcome.callSid],
        );
        await writePlatformAudit(client, {
          eventType: DEMO_CALL_CREATED_EVENT,
          entityType: 'demo_call',
          entityId: call.demoCallId,
          metadata: { leaseId: call.leaseId, callSid: outcome.callSid, leaseBound: lease.rowCount === 1 },
        });
        return;
      }
      case 'not_created': {
        const released = await releaseNoCall(client, call.demoCallId);
        // TODO(S6-4): replace with resetAndRelease (claim, purge, release).
        await client.query(
          `UPDATE demo_tenant_leases SET state = 'released', released_at = now()
            WHERE id = $1 AND call_sid IS NULL AND released_at IS NULL`,
          [call.leaseId],
        );
        await client.query(
          `UPDATE demo_calls SET status = 'failed', updated_at = now()
            WHERE id = $1 AND status = 'initiating' AND call_sid IS NULL`,
          [call.demoCallId],
        );
        const { outcome: _o, ...detail } = outcome;
        await writePlatformAudit(client, {
          eventType: DEMO_CALL_FAILED_EVENT,
          entityType: 'demo_call',
          entityId: call.demoCallId,
          metadata: {
            leaseId: call.leaseId,
            ...detail,
            budgetReturned: released.released,
            allowanceReturned: released.released && released.allowanceReturned,
          },
        });
        return;
      }
      case 'unconfirmed': {
        // Keep the lease, the reservation and the allowance: a billable call
        // may exist. A callback's terminal status still replaces this.
        await client.query(
          `UPDATE demo_calls SET status = 'unconfirmed', updated_at = now()
            WHERE id = $1 AND status = 'initiating'`,
          [call.demoCallId],
        );
        await writePlatformAudit(client, {
          eventType: DEMO_CALL_UNCONFIRMED_EVENT,
          entityType: 'demo_call',
          entityId: call.demoCallId,
          metadata: { leaseId: call.leaseId, reason: outcome.reason, httpStatus: outcome.httpStatus ?? null },
        });
        return;
      }
    }
  });
}
