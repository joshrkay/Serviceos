/**
 * NurtureEngine — resolves lifecycle events into due emails, applies
 * suppression, and sends through the allowlist gate + transport.
 *
 * Scheduling model (this deploy is stateless/serverless — see README):
 *   (a) An in-memory per-contact state map + scheduled-queue snapshot, good
 *       for the lifetime of one serverless instance / dev-server process.
 *       This is enough to demo the whole path (an event fires, due emails
 *       send immediately, the mailbox shows the result) but delayed emails
 *       (+1d, +5d, ...) will NOT actually fire days later in this process —
 *       there is nothing here that sleeps for days.
 *   (b) `computeDueEmails(state, now)` is a PURE function with no I/O: given
 *       a contact's state and a point in time, it returns exactly the emails
 *       due at that instant. A real deployment would persist ContactState
 *       (DB row per contact) and run a cron/worker every few minutes calling
 *       `engine.flushDue(now)` (or computeDueEmails directly per contact) to
 *       catch up sends. That cron does not exist yet; this module is written
 *       so plugging one in later is a persistence swap, not a logic rewrite.
 */
import type { NurtureEngine as NurtureEngineInterface, NurtureNotification } from './trigger';
import {
  NURTURE_SEQUENCES,
  TRIAL_DRIP_SEQUENCE,
  WIN_BACK_EMAIL,
  PAYMENT_FAILED_EMAIL,
  renderMergeFields,
  type NurtureEmail,
  type MergeData,
} from './sequences';
import { checkSendGate } from './allowlist';
import { selectTransport, DEFAULT_FROM_ADDRESS } from './transport';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_LENGTH_DAYS = 14;
const PAYMENT_FAILED_DEDUPE_HOURS = 24;

export interface ContactState {
  email: string;
  businessName?: string;
  vertical?: string;
  plan?: string;
  trialStartedAt?: string;
  /** Forward-looking: no lifecycle event emits this today (only 5 event types
   * exist on the bus). Settable via notification.data.firstRealCall = true so
   * the moment the product wires up real activation tracking, suppression
   * "just works" with no engine change. */
  firstRealCallAt?: string;
  trialConvertedAt?: string;
  canceledAt?: string;
  /** Timestamp of the most recent payment_failed event. */
  paymentFailedAt?: string;
  /** Timestamp we last sent the payment-failed email, keyed to the failure it answered. */
  paymentFailedSentForAt?: string;
  /** IDs from the main drip + win-back that have been sent, ever (send-once emails). */
  sentEmailIds: string[];
  /** Arbitrary product-data merge fields (calls_answered, etc.) accumulated from event payloads. */
  data: Record<string, unknown>;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function isSuppressed(email: NurtureEmail, state: ContactState): boolean {
  if (email.suppression.ifActivated && state.firstRealCallAt) return true;
  if (email.suppression.ifCanceled && state.canceledAt) return true;
  if (email.suppression.ifConverted && state.trialConvertedAt) return true;
  return false;
}

/** Derive the win-back anchor: explicit `canceled`, else trial-expiry (t0+14d)
 * once it has actually elapsed relative to `now`, else null (no anchor yet). */
function resolveWinbackAnchor(state: ContactState, now: Date): Date | null {
  if (state.trialConvertedAt) return null;
  if (state.canceledAt) return new Date(state.canceledAt);
  if (state.trialStartedAt) {
    const expiry = new Date(new Date(state.trialStartedAt).getTime() + TRIAL_LENGTH_DAYS * DAY_MS);
    if (now.getTime() >= expiry.getTime()) return expiry;
  }
  return null;
}

/**
 * PURE. Given a contact's current state and a point in time, return exactly
 * the emails due to send right now — already sent (send-once) and suppressed
 * emails excluded. No I/O, no mutation: safe for a future cron to call once
 * per contact per tick.
 */
export function computeDueEmails(state: ContactState, now: Date): NurtureEmail[] {
  const due: NurtureEmail[] = [];

  // Main trial_started drip.
  if (state.trialStartedAt) {
    const anchor = new Date(state.trialStartedAt);
    const elapsedDays = daysBetween(anchor, now);
    for (const email of TRIAL_DRIP_SEQUENCE) {
      if (state.sentEmailIds.includes(email.id)) continue;
      if (elapsedDays < email.delayDays) continue;
      if (isSuppressed(email, state)) continue;
      due.push(email);
    }
  }

  // Win-back (canceled OR derived trial-expiry; send once, ever).
  if (!state.sentEmailIds.includes(WIN_BACK_EMAIL.id) && !isSuppressed(WIN_BACK_EMAIL, state)) {
    const anchor = resolveWinbackAnchor(state, now);
    if (anchor) {
      const elapsedDays = daysBetween(anchor, now);
      if (elapsedDays >= WIN_BACK_EMAIL.delayDays) {
        due.push(WIN_BACK_EMAIL);
      }
    }
  }

  // Payment-failed (immediate; max 1 per failure event; 24h dedupe on repeated retries).
  if (state.paymentFailedAt) {
    const failureAt = new Date(state.paymentFailedAt);
    const lastSentAt = state.paymentFailedSentForAt
      ? new Date(state.paymentFailedSentForAt)
      : null;
    const alreadyHandledThisFailure = !!lastSentAt && lastSentAt.getTime() >= failureAt.getTime();
    const withinDedupeWindow =
      !!lastSentAt && now.getTime() - lastSentAt.getTime() < PAYMENT_FAILED_DEDUPE_HOURS * 60 * 60 * 1000;
    if (!alreadyHandledThisFailure && !withinDedupeWindow) {
      due.push(PAYMENT_FAILED_EMAIL);
    }
  }

  return due;
}

function buildMergeData(state: ContactState): MergeData {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '/go-live-pending';
  const firstName =
    (typeof state.data.firstName === 'string' && state.data.firstName) ||
    state.businessName?.split(' ')[0] ||
    'there';

  return {
    first_name: firstName,
    onboarding_url: `${appUrl}/onboarding`,
    app_url: appUrl,
    restart_url: '/signup',
    fix_payment_url: `${appUrl}/billing`,
    calls_answered: stringOrPlaceholder(state.data.calls_answered),
    bookings_approved: stringOrPlaceholder(state.data.bookings_approved),
    estimates_drafted: stringOrPlaceholder(state.data.estimates_drafted),
    invoices_sent: stringOrPlaceholder(state.data.invoices_sent),
  };
}

function stringOrPlaceholder(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  // Demo/preview placeholder only — production wiring resolves these from
  // real account data (see catalog-resolver-style grounding note in README).
  return '0';
}

export interface SendLogEntry {
  at: string;
  to: string;
  emailId: string;
  blocked: boolean;
  reason?: string;
  transport?: 'resend' | 'preview';
}

/**
 * The live nurture engine. Implements the NurtureEngine interface from
 * trigger.ts so it can be registered via setNurtureEngine().
 */
export class LiveNurtureEngine implements NurtureEngineInterface {
  private contacts = new Map<string, ContactState>();
  private log: SendLogEntry[] = [];

  private getOrCreate(email: string): ContactState {
    let state = this.contacts.get(email);
    if (!state) {
      state = { email, sentEmailIds: [], data: {} };
      this.contacts.set(email, state);
    }
    return state;
  }

  private applyEvent(state: ContactState, notification: NurtureNotification): void {
    const now = new Date().toISOString();
    if (notification.businessName) state.businessName = notification.businessName;
    if (notification.vertical) state.vertical = notification.vertical;
    if (notification.plan) state.plan = notification.plan;
    state.data = { ...state.data, ...notification.data };

    switch (notification.type) {
      case 'trial_started':
        state.trialStartedAt = state.trialStartedAt ?? now;
        break;
      case 'trial_converted':
        state.trialConvertedAt = state.trialConvertedAt ?? now;
        break;
      case 'canceled':
        state.canceledAt = state.canceledAt ?? now;
        break;
      case 'payment_failed':
        state.paymentFailedAt = now;
        break;
      case 'payment_past_due':
        // No nurture email for this event by design (handled by in-product
        // billing dunning) — logged by the lifecycle bus, nothing to do here.
        break;
      default:
        break;
    }

    if (notification.data && notification.data.firstRealCall) {
      state.firstRealCallAt = state.firstRealCallAt ?? now;
    }
  }

  private async sendOne(state: ContactState, email: NurtureEmail): Promise<void> {
    const gate = checkSendGate(state.email);
    if (gate.blocked) {
      const entry: SendLogEntry = {
        at: new Date().toISOString(),
        to: state.email,
        emailId: email.id,
        blocked: true,
        reason: gate.reason,
      };
      this.log.push(entry);
      console.log(JSON.stringify({ source: 'nurture.gate', ...entry }));
      return; // BLOCKED — never reaches a transport, regardless of env/key.
    }

    const mergeData = buildMergeData(state);
    const subject = renderMergeFields(email.subject, mergeData);
    const bodyHtml = renderMergeFields(email.bodyHtml, mergeData);
    const bodyText = renderMergeFields(email.bodyText, mergeData);

    const transport = selectTransport();
    const result = await transport.send({
      to: state.email,
      from: DEFAULT_FROM_ADDRESS,
      subject,
      bodyHtml,
      bodyText,
      emailId: email.id,
      previewText: email.previewText,
    });

    const entry: SendLogEntry = {
      at: new Date().toISOString(),
      to: state.email,
      emailId: email.id,
      blocked: false,
      transport: transport.name,
    };
    this.log.push(entry);

    if (!result.ok) {
      console.log(
        JSON.stringify({ source: 'nurture.send-failed', ...entry, error: result.error }),
      );
      return;
    }

    // Mark send-once emails as sent so computeDueEmails never re-selects them.
    if (email.id === PAYMENT_FAILED_EMAIL.id) {
      state.paymentFailedSentForAt = new Date().toISOString();
    } else {
      state.sentEmailIds.push(email.id);
    }
  }

  private async sendDue(state: ContactState, now: Date): Promise<void> {
    const due = computeDueEmails(state, now);
    for (const email of due) {
      await this.sendOne(state, email);
    }
  }

  async notify(notification: NurtureNotification): Promise<void> {
    if (!notification.email) {
      console.log(
        JSON.stringify({
          source: 'nurture.engine',
          skipped: true,
          reason: 'no email on lifecycle event',
          type: notification.type,
        }),
      );
      return;
    }

    const state = this.getOrCreate(notification.email);
    this.applyEvent(state, notification);
    await this.sendDue(state, new Date());
  }

  /** For a future cron: recompute + send due emails for every known contact. */
  async flushDue(now: Date = new Date()): Promise<void> {
    for (const state of this.contacts.values()) {
      await this.sendDue(state, now);
    }
  }

  /** Read-only snapshot for the preview page / tests. */
  getContactState(email: string): ContactState | undefined {
    return this.contacts.get(email);
  }

  getSendLog(): readonly SendLogEntry[] {
    return this.log;
  }
}

export const liveNurtureEngine = new LiveNurtureEngine();

// Re-export for convenience/tests.
export { NURTURE_SEQUENCES };
