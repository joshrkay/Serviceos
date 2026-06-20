import { describe, expect, it } from 'vitest';
import { routeForNotification } from './notificationRouting';

describe('routeForNotification', () => {
  it('uses an explicit screen path when present', () => {
    expect(routeForNotification({ screen: '/proposals/p1', proposalId: 'p1', kind: 'needs_approval' })).toBe(
      '/proposals/p1',
    );
  });

  it('derives the review route from proposalId when screen is absent', () => {
    expect(routeForNotification({ proposalId: 'abc', kind: 'executed' })).toBe('/proposals/abc');
  });

  it('returns null when there is nothing actionable', () => {
    expect(routeForNotification(null)).toBeNull();
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification({})).toBeNull();
    expect(routeForNotification({ kind: 'executed' })).toBeNull();
    expect(routeForNotification({ proposalId: '' })).toBeNull();
    expect(routeForNotification({ screen: 'proposals/p1' })).toBeNull(); // not an absolute path
  });
});
