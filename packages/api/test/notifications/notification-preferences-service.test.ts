import { describe, it, expect } from 'vitest';
import {
  InMemoryNotificationPreferenceRepository,
  isNotificationType,
  toPreferenceMap,
} from '../../src/notifications/notification-preferences-service';
import { NOTIFICATION_TYPES } from '@ai-service-os/shared';

describe('isNotificationType', () => {
  it('accepts known types and rejects everything else', () => {
    expect(isNotificationType('payment_received')).toBe(true);
    expect(isNotificationType('nope')).toBe(false);
    expect(isNotificationType(undefined)).toBe(false);
    expect(isNotificationType(42)).toBe(false);
  });
});

describe('toPreferenceMap', () => {
  it('defaults every category to enabled, then overlays explicit rows', () => {
    const map = toPreferenceMap([
      { tenantId: 't1', userId: 'u1', notificationType: 'payment_received', enabled: false },
      { tenantId: 't1', userId: 'u1', notificationType: 'emergency', enabled: true },
    ]);
    expect(map.payment_received).toBe(false);
    expect(map.emergency).toBe(true);
    // Untouched categories stay default-on.
    expect(map.incoming_call).toBe(true);
    // Every type is present.
    for (const t of NOTIFICATION_TYPES) expect(typeof map[t]).toBe('boolean');
  });
});

describe('InMemoryNotificationPreferenceRepository', () => {
  it('treats absence as enabled — no muted users by default', async () => {
    const repo = new InMemoryNotificationPreferenceRepository();
    expect(await repo.listByUser('t1', 'u1')).toEqual([]);
    expect((await repo.listMutedUserIds('t1', 'payment_received')).size).toBe(0);
  });

  it('upserts a preference and reports muted users for that type only', async () => {
    const repo = new InMemoryNotificationPreferenceRepository();
    await repo.set('t1', 'u1', 'payment_received', false);
    await repo.set('t1', 'u2', 'invoice_overdue', false);

    const mutedPayment = await repo.listMutedUserIds('t1', 'payment_received');
    expect(mutedPayment).toEqual(new Set(['u1']));
    // u2 muted a different type — not in the payment set.
    expect(mutedPayment.has('u2')).toBe(false);

    // Re-enabling removes them from the muted set (upsert, not insert).
    await repo.set('t1', 'u1', 'payment_received', true);
    expect((await repo.listMutedUserIds('t1', 'payment_received')).size).toBe(0);
  });

  it('scopes by tenant', async () => {
    const repo = new InMemoryNotificationPreferenceRepository();
    await repo.set('t1', 'u1', 'emergency', false);
    expect((await repo.listMutedUserIds('t2', 'emergency')).size).toBe(0);
    expect(await repo.listByUser('t2', 'u1')).toEqual([]);
  });
});
