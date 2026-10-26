/**
 * U7-05+ — the operator CLI for the one-time webhook_events payload backfill.
 * DRY RUN unless `--apply`; resumable with `--after <id>`. The loop and the
 * store are tested in test/webhooks/webhook-payload-backfill.test.ts and
 * test/integration/webhook-events-pii-backfill.test.ts; this pins the
 * argument contract and the audit row an applied run writes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseMinimizeArgs,
  auditBackfillRun,
  BACKFILL_AUDIT_EVENT_TYPE,
} from '../../scripts/backfill-webhook-events-minimize';
import type { WebhookPayloadBackfillResult } from '../../src/webhooks/webhook-payload-backfill';

const UUID = '3f1e6d1c-2b4a-4c8e-9f7d-1a2b3c4d5e6f';

describe('parseMinimizeArgs', () => {
  it('defaults to a dry run of 500-row pages from the start, with no pause or audit', () => {
    expect(parseMinimizeArgs([])).toEqual({ apply: false, batchSize: 500, pauseMs: 0 });
  });

  it('reads every flag', () => {
    expect(
      parseMinimizeArgs([
        '--apply',
        '--batch-size', '200',
        '--after', UUID,
        '--max-batches', '10',
        '--pause-ms', '50',
        '--audit-tenant-id', UUID,
      ]),
    ).toEqual({ apply: true, batchSize: 200, afterId: UUID, maxBatches: 10, pauseMs: 50, auditTenantId: UUID });
  });

  it('rejects a malformed cursor, tenant id or number', () => {
    expect(() => parseMinimizeArgs(['--after', 'not-a-uuid'])).toThrow(/--after/);
    expect(() => parseMinimizeArgs(['--audit-tenant-id', 'x'])).toThrow(/--audit-tenant-id/);
    expect(() => parseMinimizeArgs(['--batch-size', '0'])).toThrow(/--batch-size/);
    expect(() => parseMinimizeArgs(['--batch-size', '6000'])).toThrow(/--batch-size/);
    expect(() => parseMinimizeArgs(['--max-batches', '-1'])).toThrow(/--max-batches/);
    expect(() => parseMinimizeArgs(['--pause-ms', 'soon'])).toThrow(/--pause-ms/);
    expect(() => parseMinimizeArgs(['--bogus'])).toThrow(/--bogus/);
  });

  it('refuses --apply without --audit-tenant-id, so every rewrite leaves an audit row', () => {
    expect(() => parseMinimizeArgs(['--apply'])).toThrow(/--apply requires --audit-tenant-id/);
    expect(parseMinimizeArgs(['--apply', '--audit-tenant-id', UUID])).toMatchObject({ apply: true, auditTenantId: UUID });
    expect(parseMinimizeArgs(['--audit-tenant-id', UUID])).toMatchObject({ apply: false, auditTenantId: UUID });
  });
});

describe('auditBackfillRun', () => {
  const result: WebhookPayloadBackfillResult = {
    apply: true,
    scanned: 10,
    rewritten: 7,
    alreadyMinimal: 2,
    skippedChanged: 0,
    unclassified: { legacy_x: 1 },
    batches: 1,
    lastId: UUID,
    complete: true,
  };

  it('writes one platform-tagged audit row with the counts and the cursor range (no payload content)', async () => {
    const create = vi.fn(async (e: unknown) => e);
    await auditBackfillRun({ create } as never, UUID, { afterId: undefined, result });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      tenantId: UUID,
      actorId: 'system:webhook-payload-backfill',
      actorRole: 'system',
      eventType: BACKFILL_AUDIT_EVENT_TYPE,
      entityType: 'webhook_events',
      entityId: 'payload-allowlist',
      metadata: {
        actor_type: 'platform',
        startedAfter: null,
        lastId: UUID,
        complete: true,
        scanned: 10,
        rewritten: 7,
        alreadyMinimal: 2,
        skippedChanged: 0,
        unclassified: { legacy_x: 1 },
      },
    });
  });
});
