import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  armEmergencyPageLadder,
  resolveEmergencyPageLadder,
  composeEmergencyRetryPage,
  EMERGENCY_PAGE_INTERVAL_MS,
  MAX_EMERGENCY_PAGES,
  __clearEmergencyPageLaddersForTests,
} from '../../src/telephony/emergency-page-retry';
import { InMemoryCallMeBackRepository } from '../../src/voice/call-me-back/call-me-back';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const INPUT = {
  tenantId: 't1',
  sessionId: 's1',
  callSid: 'CA-1',
  callerPhone: '+15125550111',
  emergencyDescription: 'gas leak in the basement',
  businessName: 'Acme Plumbing',
};

describe('RV-143 — emergency page-retry ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    __clearEmergencyPageLaddersForTests();
    vi.useRealTimers();
  });

  function makeDeps(overrides: Partial<Parameters<typeof armEmergencyPageLadder>[1]> = {}) {
    const sent: Array<{ to: string; body: string }> = [];
    const deps = {
      sendSms: vi.fn(async (args: { to: string; body: string }) => {
        sent.push(args);
        return {};
      }),
      resolvePagePhone: vi.fn(async () => '+15125550999'),
      isResolved: vi.fn(() => false),
      ...overrides,
    };
    return { deps, sent };
  }

  it('pages the owner 3 times at 2-minute intervals when the transfer stays unanswered', async () => {
    const { deps, sent } = makeDeps();
    armEmergencyPageLadder(INPUT, deps);

    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+15125550999');
    expect(sent[0].body).toContain('page 1/3');
    expect(sent[0].body).toContain('+15125550111');

    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain('page 2/3');

    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS);
    expect(sent).toHaveLength(3);
    expect(sent[2].body).toContain('page 3/3');

    // No fourth page, ever.
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 5);
    expect(sent).toHaveLength(3);
    expect(MAX_EMERGENCY_PAGES).toBe(3);
  });

  it('stops paging once the transfer is answered (isResolved flips true)', async () => {
    let resolved = false;
    const { deps, sent } = makeDeps({ isResolved: vi.fn(() => resolved) });
    armEmergencyPageLadder(INPUT, deps);

    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS);
    expect(sent).toHaveLength(1);

    resolved = true;
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 4);
    expect(sent).toHaveLength(1);
  });

  it('resolveEmergencyPageLadder cancels pending pages immediately', async () => {
    const { deps, sent } = makeDeps();
    armEmergencyPageLadder(INPUT, deps);
    resolveEmergencyPageLadder('t1', 's1');
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 4);
    expect(sent).toHaveLength(0);
  });

  it('is idempotent per (tenant, session) — double-arm never double-pages', async () => {
    const { deps, sent } = makeDeps();
    armEmergencyPageLadder(INPUT, deps);
    armEmergencyPageLadder(INPUT, deps);
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it('a failed page does not stop the ladder (next attempt still fires)', async () => {
    const calls: number[] = [];
    const { deps } = makeDeps({
      sendSms: vi.fn(async () => {
        calls.push(Date.now());
        if (calls.length === 1) throw new Error('provider down');
        return {};
      }),
    });
    armEmergencyPageLadder(INPUT, deps);
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 2);
    expect(calls).toHaveLength(2);
  });

  it('exhausted ladder lands a durable urgent call_me_back task', async () => {
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { deps } = makeDeps({ callMeBackRepo, auditRepo });
    armEmergencyPageLadder(INPUT, deps);

    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 3 + 10);
    const pending = await callMeBackRepo.listPending('t1');
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('emergency_unanswered');
    expect(pending[0].callerPhone).toBe('+15125550111');
    expect(pending[0].callbackMessage).toContain('EMERGENCY');
    expect(
      auditRepo.events.filter((e) => e.eventType === 'emergency_page.sent'),
    ).toHaveLength(3);
  });

  it('no resolvable page phone → no SMS, ladder still exhausts into the queue', async () => {
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const { deps, sent } = makeDeps({
      resolvePagePhone: vi.fn(async () => null),
      callMeBackRepo,
    });
    armEmergencyPageLadder(INPUT, deps);
    await vi.advanceTimersByTimeAsync(EMERGENCY_PAGE_INTERVAL_MS * 3 + 10);
    expect(sent).toHaveLength(0);
    expect(await callMeBackRepo.listPending('t1')).toHaveLength(1);
  });
});

describe('composeEmergencyRetryPage', () => {
  it('caps the body at 320 chars and counts attempts', () => {
    const body = composeEmergencyRetryPage(
      { ...INPUT, emergencyDescription: 'y'.repeat(400) },
      2,
      3,
    );
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body).toContain('2/3');
  });
});
