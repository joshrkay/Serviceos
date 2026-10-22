/**
 * D-045 item 6 — senders move to outbound messaging one file at a time, and
 * this list of files that still call a delivery provider's `sendSms` directly
 * may only shrink.
 *
 * A new file calling `.sendSms(` fails here: send through
 * `notifications/outbound-messaging.ts` instead, naming the recipient and the
 * message purpose. A file that stops calling it also fails until it is removed
 * from the list, so the list always says where the migration stands.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../src');

/** The module itself and the delivery layers under it, which must call it. */
const TRANSPORT = new Set([
  'notifications/outbound-messaging.ts',
  'notifications/gated-message-delivery.ts',
  'notifications/per-tenant-twilio-delivery-provider.ts',
]);

/** Direct callers not yet moved to outbound messaging. Only remove entries. */
const NOT_YET_MIGRATED = new Set([
  'ai/skills/patch-owner-through.ts',
  'ai/tasks/proposal-approval-task.ts',
  'ai/voice-turn/create-voice-turn-processor.ts',
  'app.ts',
  'appointments/assignment-notifications.ts',
  'conversations/reply-service.ts',
  'feedback/dispatcher.ts',
  'monitoring/alert-operator.ts',
  'notifications/customer-message-delivery.ts',
  'notifications/owner-sms-sender.ts',
  'notifications/twilio-customer-message-service.ts',
  'notifications/twilio-delay-notification-service.ts',
  'proposals/auto-approve.ts',
  'proposals/execution/emergency-dispatch-handler.ts',
  'proposals/lane-undo-sms.ts',
  'proposals/sms/reply-handler.ts',
  'reputation/private-message-sender-adapter.ts',
  'sms/negotiation/inbound-negotiation-handler.ts',
  'sms/recovery/dropped-call-handler.ts',
  'sms/recovery/resume-handler.ts',
  'telephony/emergency-page-retry.ts',
  'telephony/media-streams/mediastream-adapter.ts',
  'voice/triage/owner-cell-patch.ts',
  'workers/call-me-back-worker.ts',
  'workers/daily-digest-worker.ts',
  'workers/hfcr-weekly-send-worker.ts',
  'workers/pin-lock-alert-retry.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const directCallers = sourceFiles(SRC)
  .filter((path) => /\.sendSms\(/.test(readFileSync(path, 'utf8')))
  .map((path) => relative(SRC, path).split('\\').join('/'))
  .sort();

describe('outbound messaging migration guard (D-045)', () => {
  it('no new file sends a text around outbound messaging', () => {
    const unlisted = directCallers.filter((f) => !TRANSPORT.has(f) && !NOT_YET_MIGRATED.has(f));
    expect(unlisted).toEqual([]);
  });

  it('a migrated file is taken off the list', () => {
    const migrated = [...NOT_YET_MIGRATED].filter((f) => !directCallers.includes(f));
    expect(migrated).toEqual([]);
  });
});
