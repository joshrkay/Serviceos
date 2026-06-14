/**
 * Unit tests for the pure recency formatter
 * (src/customers/customer-negotiation-context.ts). The DB-backed provider is
 * pinned by the Docker-gated integration test
 * (test/integration/customer-negotiation-context.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatRecencyLabel } from '../../src/customers/customer-negotiation-context';

const NOW = new Date('2026-06-14T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

describe('formatRecencyLabel', () => {
  it('labels a customer with no history as new', () => {
    expect(formatRecencyLabel(null, NOW)).toBe('new customer');
  });

  it('labels recent activity', () => {
    expect(formatRecencyLabel(daysAgo(0), NOW)).toBe('today');
    expect(formatRecencyLabel(daysAgo(1), NOW)).toBe('yesterday');
    expect(formatRecencyLabel(daysAgo(3), NOW)).toBe('3 days ago');
  });

  it('labels weeks and months', () => {
    expect(formatRecencyLabel(daysAgo(10), NOW)).toBe('last week');
    expect(formatRecencyLabel(daysAgo(18), NOW)).toBe('2 weeks ago');
    expect(formatRecencyLabel(daysAgo(45), NOW)).toBe('last month');
    expect(formatRecencyLabel(daysAgo(90), NOW)).toBe('3 months ago');
  });

  it('labels years', () => {
    expect(formatRecencyLabel(daysAgo(400), NOW)).toBe('about a year ago');
    expect(formatRecencyLabel(daysAgo(800), NOW)).toBe('2 years ago');
  });

  it('treats a future-dated row as today rather than reporting a negative age', () => {
    expect(formatRecencyLabel(new Date(NOW.getTime() + 86_400_000), NOW)).toBe('today');
  });
});
