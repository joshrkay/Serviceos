/**
 * Voice-parity (Feature 7) — call_me_back sweeper.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runCallMeBackSweep,
  buildCallbackNotificationSms,
} from '../../src/workers/call-me-back-worker';
import { InMemoryCallMeBackRepository } from '../../src/voice/call-me-back/call-me-back';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import type { Logger } from '../../src/logging/logger';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function settingsRepoReturning(
  partial: Partial<TenantSettings> | null,
): SettingsRepository {
  return {
    findByTenant: vi.fn(async () => (partial as TenantSettings | null)),
  } as unknown as SettingsRepository;
}

describe('runCallMeBackSweep', () => {
  it('notifies the CSR (transfer_number) and marks pending tasks notified', async () => {
    const repo = new InMemoryCallMeBackRepository();
    await repo.create({
      tenantId: 'T1',
      callerPhone: '+15125550142',
      callbackMessage: 'AC is broken, call me back',
    });
    const sent: { to: string; body: string }[] = [];
    const deliveryProvider = {
      sendSms: vi.fn(async (a: { to: string; body: string }) => {
        sent.push(a);
      }),
    };

    const result = await runCallMeBackSweep({
      callMeBackRepo: repo,
      settingsRepo: settingsRepoReturning({
        transferNumber: '+15125557000',
        businessName: 'Acme Plumbing',
      }),
      deliveryProvider,
      listTenantIds: async () => ['T1'],
      logger,
    });

    expect(result.notified).toBe(1);
    expect(result.failed).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+15125557000');
    expect(sent[0].body).toContain('AC is broken');
    // Task transitioned out of pending.
    expect(await repo.listPending('T1')).toHaveLength(0);
  });

  it('leaves tasks pending when no transfer_number is configured', async () => {
    const repo = new InMemoryCallMeBackRepository();
    await repo.create({ tenantId: 'T2', callerPhone: '+15125550143' });
    const deliveryProvider = { sendSms: vi.fn(async () => undefined) };

    const result = await runCallMeBackSweep({
      callMeBackRepo: repo,
      settingsRepo: settingsRepoReturning({ businessName: 'No Line Co' }),
      deliveryProvider,
      listTenantIds: async () => ['T2'],
      logger,
    });

    expect(result.notified).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deliveryProvider.sendSms).not.toHaveBeenCalled();
    expect(await repo.listPending('T2')).toHaveLength(1);
  });

  it('swallows a single tenant failure and keeps sweeping the rest', async () => {
    const repo = new InMemoryCallMeBackRepository();
    await repo.create({ tenantId: 'GOOD', callerPhone: '+15125550144' });
    // Settings repo throws for BAD, returns a line for GOOD.
    const settingsRepo = {
      findByTenant: vi.fn(async (tenantId: string) => {
        if (tenantId === 'BAD') throw new Error('boom');
        return { transferNumber: '+15125557000', businessName: 'Good Co' } as unknown as TenantSettings;
      }),
    } as unknown as SettingsRepository;
    const deliveryProvider = { sendSms: vi.fn(async () => undefined) };

    const result = await runCallMeBackSweep({
      callMeBackRepo: repo,
      settingsRepo,
      deliveryProvider,
      listTenantIds: async () => ['BAD', 'GOOD'],
      logger,
    });

    expect(result.tenants).toBe(2);
    expect(result.notified).toBe(1);
  });

  it('buildCallbackNotificationSms includes caller, number, and message', () => {
    const sms = buildCallbackNotificationSms(
      {
        id: 't1',
        tenantId: 'T1',
        callerPhone: '+15125550142',
        callerName: 'María López',
        callbackMessage: 'Water heater leaking',
        reason: 'transfer_failed',
        status: 'pending',
        scheduledFor: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      'Acme Plumbing',
    );
    expect(sms).toContain('Acme Plumbing');
    expect(sms).toContain('María López');
    expect(sms).toContain('+15125550142');
    expect(sms).toContain('Water heater leaking');
  });
});

describe('InMemoryCallMeBackRepository — pending semantics', () => {
  it('listPending excludes callbacks scheduled in the future', async () => {
    const repo = new InMemoryCallMeBackRepository();
    await repo.create({ tenantId: 'T1', callerPhone: '+15125550142' }); // due now
    await repo.create({
      tenantId: 'T1',
      callerPhone: '+15125550143',
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000), // 1h out
    });

    const pending = await repo.listPending('T1');
    expect(pending).toHaveLength(1);
    expect(pending[0].callerPhone).toBe('+15125550142');
  });

  it('markNotified only transitions pending rows (no clobbering terminal status)', async () => {
    const repo = new InMemoryCallMeBackRepository();
    const task = await repo.create({ tenantId: 'T1', callerPhone: '+15125550142' });

    // CSR completed it before the sweep got to markNotified.
    await repo.markCompleted('T1', task.id);
    const result = await repo.markNotified('T1', task.id);

    expect(result).toBeNull(); // no-op
    // Status stays completed — not reverted to notified.
    expect(await repo.listPending('T1')).toHaveLength(0);
  });
});
