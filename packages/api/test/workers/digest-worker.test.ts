/**
 * P5-020 — DigestWorker unit tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { runDigestSweep, handleOwnerReply } from '../../src/workers/digest-worker';
import type { DigestEntryRepository } from '../../src/workers/digest-worker';
import type { DigestEntry, DigestSourceData } from '../../src/digest/digest-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Phoenix is UTC-7 (no DST observed).
// Jan 15 2026, 7pm Phoenix = Jan 16 2026 02:00 UTC
const IN_WINDOW_UTC = '2026-01-16T02:00:00Z'; // 7pm Phoenix, local date = 2026-01-15
const OUT_OF_WINDOW_UTC = '2026-01-15T15:00:00Z'; // 8am Phoenix, local date = 2026-01-15
const LOCAL_DATE = '2026-01-15';

function makeSourceData(): DigestSourceData {
  return {
    completedJobIds: [],
    sentEstimateIds: [],
    followUpInvoiceIds: [],
    tomorrowAppointmentIds: [],
    uncertainProposalIds: [],
    correctionChunkIds: [],
  };
}

function makeEntry(overrides: Partial<DigestEntry> = {}): DigestEntry {
  const ts = new Date(IN_WINDOW_UTC);
  return {
    id: 'entry-1',
    tenantId: 'tenant-1',
    date: LOCAL_DATE,
    status: 'pending',
    attemptCount: 0,
    renderedText: [
      'Acme Plumbing — end of day update:',
      'Jobs wrapped up today: 2 jobs completed.',
      'Reply LOOKS GOOD or tell me what to fix.',
    ].join('\n'),
    sourceData: makeSourceData(),
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeInMemoryDigestRepo(): DigestEntryRepository & {
  _entries: Map<string, DigestEntry>;
} {
  const entries = new Map<string, DigestEntry>();
  return {
    _entries: entries,
    async findByTenantAndDate(tenantId: string, date: string) {
      return entries.get(`${tenantId}:${date}`) ?? null;
    },
    async insert(tenantId: string, date: string, renderedText: string, sourceData: DigestSourceData) {
      const key = `${tenantId}:${date}`;
      const existing = entries.get(key);
      if (existing) return existing;
      const entry = makeEntry({ tenantId, date, renderedText, sourceData });
      entries.set(key, entry);
      return entry;
    },
    async update(tenantId: string, date: string, patch: Partial<DigestEntry>) {
      const key = `${tenantId}:${date}`;
      const existing = entries.get(key);
      if (!existing) return null;
      const updated: DigestEntry = { ...existing, ...patch, updatedAt: new Date() };
      entries.set(key, updated);
      return updated;
    },
  };
}

function makeSettings(timezone = 'America/Phoenix', ownerPhone = '+16025550001') {
  return {
    findByTenant: vi.fn(async (_tenantId: string) => ({
      tenantId: _tenantId,
      businessName: 'Acme Plumbing',
      timezone,
      ownerPhone,
      digestEnabled: true,
    } as any)),
  };
}

function makeMockPool() {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(),
  } as any;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DigestWorker — runDigestSweep', () => {
  it('delivers digest to tenant in 6–9pm Phoenix-local delivery window (fake clock)', async () => {
    // 2026-01-16T02:00:00Z = 7pm Phoenix local time on Jan 15
    const now = new Date(IN_WINDOW_UTC);
    const sendSms = vi.fn(async () => {});
    const digestEntryRepo = makeInMemoryDigestRepo();

    const result = await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.sent).toBe(1);
    expect(sendSms).toHaveBeenCalled();
  });

  it('does NOT deliver outside delivery window', async () => {
    // 2026-01-15T15:00:00Z = 8am Phoenix local time on Jan 15
    const now = new Date(OUT_OF_WINDOW_UTC);
    const sendSms = vi.fn(async () => {});
    const digestEntryRepo = makeInMemoryDigestRepo();

    const result = await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('retries: delivery fails twice, succeeds on third attempt', async () => {
    // All three calls use the same in-window timestamp and share the same repo
    const now = new Date(IN_WINDOW_UTC);
    let callCount = 0;
    const sendSms = vi.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error('SMS provider down');
    });
    const digestEntryRepo = makeInMemoryDigestRepo();
    const logger = makeLogger();

    // First call — SMS fails
    await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger,
      now: () => now,
    });

    // Second call — SMS fails again
    await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger,
      now: () => now,
    });

    // Third call — succeeds
    const result = await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger,
      now: () => now,
    });

    expect(result.sent).toBe(1);
    expect(callCount).toBe(3);
  });

  it('idempotency: re-running sweep with a delivered entry does not re-send', async () => {
    const now = new Date(IN_WINDOW_UTC); // 7pm Phoenix on Jan 15 → localDate = 2026-01-15
    const sendSms = vi.fn(async () => {});
    const digestEntryRepo = makeInMemoryDigestRepo();

    // Pre-populate a delivered entry for the same local date the worker will compute
    await digestEntryRepo.insert('tenant-1', LOCAL_DATE, 'msg', makeSourceData());
    await digestEntryRepo.update('tenant-1', LOCAL_DATE, { status: 'delivered' });

    const result = await runDigestSweep({
      digestEntryRepo,
      settingsRepo: makeSettings() as any,
      pool: makeMockPool(),
      listTenantIds: async () => ['tenant-1'],
      sendSms,
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe('handleOwnerReply', () => {
  it('sets status to acked when owner replies "LOOKS GOOD"', async () => {
    const digestEntryRepo = makeInMemoryDigestRepo();
    // now = 7pm Phoenix on Jan 15 → localDate = 2026-01-15
    const now = new Date(IN_WINDOW_UTC);

    // Insert and deliver for the correct local date
    await digestEntryRepo.insert('tenant-1', LOCAL_DATE, 'msg', makeSourceData());
    await digestEntryRepo.update('tenant-1', LOCAL_DATE, { status: 'delivered' });

    await handleOwnerReply('tenant-1', 'LOOKS GOOD', digestEntryRepo, 'America/Phoenix', now);

    const entry = await digestEntryRepo.findByTenantAndDate('tenant-1', LOCAL_DATE);
    expect(entry?.status).toBe('acked');
    expect(entry?.ownerReply).toBe('LOOKS GOOD');
  });

  it('records free-text owner reply as feedback and sets status to acked', async () => {
    const digestEntryRepo = makeInMemoryDigestRepo();
    const now = new Date(IN_WINDOW_UTC);

    await digestEntryRepo.insert('tenant-1', LOCAL_DATE, 'msg', makeSourceData());
    await digestEntryRepo.update('tenant-1', LOCAL_DATE, { status: 'delivered' });

    const reply = 'The job count was wrong, we completed 5 not 3';
    await handleOwnerReply('tenant-1', reply, digestEntryRepo, 'America/Phoenix', now);

    const entry = await digestEntryRepo.findByTenantAndDate('tenant-1', LOCAL_DATE);
    expect(entry?.status).toBe('acked');
    expect(entry?.ownerReply).toBe(reply);
  });
});
