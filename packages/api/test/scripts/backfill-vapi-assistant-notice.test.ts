/**
 * PRIV-4 — Vapi assistants created before the virtual-assistant notice keep
 * their old first message. The backfill re-pushes the first message
 * provisioning would build today, and is a DRY RUN unless `--apply` is
 * passed. The planner is tested here with the Vapi client injected; the row
 * query is pinned at real Postgres in
 * test/integration/backfill-vapi-assistant-notice.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  firstMessageFor,
  parseVapiNoticeArgs,
  runVapiNoticeBackfill,
  type VapiNoticeRow,
} from '../../scripts/backfill-vapi-assistant-notice';

const NOTICE_EN = "Just so you know, I'm a virtual assistant, not a live person.";
const NOTICE_ES = 'Para que lo sepa, soy un asistente virtual, no una persona real.';

function row(overrides: Partial<VapiNoticeRow> = {}): VapiNoticeRow {
  return {
    tenantId: 'tenant-a',
    assistantId: 'asst_a',
    businessName: 'Acme HVAC',
    greeting: null,
    services: ['heating'],
    defaultLanguage: 'en',
    ...overrides,
  };
}

const quiet = () => undefined;

describe('backfill-vapi-assistant-notice (PRIV-4)', () => {
  it('parses --apply and --tenant-id; dry run by default', () => {
    expect(parseVapiNoticeArgs([])).toEqual({ apply: false });
    expect(parseVapiNoticeArgs(['--apply', '--tenant-id', 't1'])).toEqual({ apply: true, tenantId: 't1' });
  });

  it('builds the first message like provisioning: stored greeting, else the auto greeting, then the notice', () => {
    expect(firstMessageFor(row({ greeting: 'Hi, Acme here!' }))).toBe(`Hi, Acme here! ${NOTICE_EN}`);
    const auto = firstMessageFor(row());
    expect(auto.startsWith('Thanks for calling Acme HVAC.')).toBe(true);
    expect(auto.endsWith(NOTICE_EN)).toBe(true);
    expect(firstMessageFor(row({ greeting: 'Gracias por llamar.', defaultLanguage: 'es' }))).toBe(
      `Gracias por llamar. ${NOTICE_ES}`,
    );
  });

  it('is a dry run by default: reports what it would set and changes nothing', async () => {
    const vapi = { updateAssistant: vi.fn() };
    const result = await runVapiNoticeBackfill({ rows: [row()], vapi, apply: false, log: quiet });
    expect(vapi.updateAssistant).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ would_set: 1, set: 0, skipped: 0, failed: 0 });
    expect(result.reports[0].detail).toContain(NOTICE_EN);
  });

  it('with --apply pushes only firstMessage to each assistant and skips tenants with none', async () => {
    const vapi = { updateAssistant: vi.fn(async () => undefined) };
    const result = await runVapiNoticeBackfill({
      rows: [row(), row({ tenantId: 'tenant-b', assistantId: null })],
      vapi,
      apply: true,
      log: quiet,
    });
    expect(vapi.updateAssistant).toHaveBeenCalledTimes(1);
    expect(vapi.updateAssistant).toHaveBeenCalledWith('asst_a', { firstMessage: firstMessageFor(row()) });
    expect(result.counts).toEqual({ would_set: 0, set: 1, skipped: 1, failed: 0 });
  });

  it('a Vapi failure on one assistant is reported and does not stop the rest', async () => {
    const vapi = {
      updateAssistant: vi.fn(async (id: string) => {
        if (id === 'asst_a') throw new Error('Vapi PATCH /assistant/asst_a failed: 500');
      }),
    };
    const result = await runVapiNoticeBackfill({
      rows: [row(), row({ tenantId: 'tenant-b', assistantId: 'asst_b' })],
      vapi,
      apply: true,
      log: quiet,
    });
    expect(result.counts).toEqual({ would_set: 0, set: 1, skipped: 0, failed: 1 });
    expect(result.reports[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('500') });
  });
});
