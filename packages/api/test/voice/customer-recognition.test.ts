/**
 * Feature 3 — Customer recognition (returning vs new).
 *
 * Returning callers get a name + last-service opener in their language; new
 * callers fall through to the standard greeting (builder returns null).
 */
import { describe, it, expect } from 'vitest';
import { loadCustomers } from './_fixtures';
import { buildReturningCustomerGreeting } from '../../src/voice/parity/returning-greeting';

const fixtures = loadCustomers();

describe('Feature 3 — customer recognition', () => {
  const returning = fixtures.filter((f) => f.scenario === 'returning');
  const newCallers = fixtures.filter((f) => f.scenario === 'new');

  it.each(returning)('returning caller greeting references identity: $name', (f) => {
    const greeting = buildReturningCustomerGreeting({
      customerName: f.customerName,
      language: f.language,
      timezone: f.timezone,
      lastService: f.lastService
        ? { date: new Date(f.lastService.date), type: f.lastService.type }
        : null,
    });
    expect(greeting).not.toBeNull();
    for (const fragment of f.expectedGreetingContains) {
      expect(greeting as string).toContain(fragment);
    }
  });

  it.each(newCallers)('new caller falls through to standard greeting: $name', (f) => {
    const greeting = buildReturningCustomerGreeting({
      customerName: f.customerName,
      language: f.language,
      timezone: f.timezone,
      lastService: null,
    });
    expect(greeting).toBeNull();
  });

  it('keeps a Spanish returning greeting fully Spanish (no English bleed)', () => {
    const greeting = buildReturningCustomerGreeting({
      customerName: 'María',
      language: 'es',
      timezone: 'America/New_York',
      lastService: { date: new Date('2026-03-12T15:00:00.000Z'), type: 'revisión' },
    });
    expect(greeting).toContain('bienvenido');
    expect(greeting).not.toContain('welcome back');
    expect(greeting).not.toContain('calling about');
  });
});
