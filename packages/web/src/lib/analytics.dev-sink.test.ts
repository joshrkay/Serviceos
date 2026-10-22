import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackFunnel, track, __resetAnalyticsForTests } from './analytics';

/**
 * S3-6 (plan U4) — the real-stack e2e lane runs with no analytics key, so
 * every event is a no-op on the wire. A page that defines `window.__v3Events`
 * (the Playwright spec does, in an init script) gets each v3 funnel event
 * pushed onto it, in a dev build only, so the lane can read what the funnel
 * would have recorded (`v3_choice_made.answer_mode` per turn).
 */
type Sink = { __v3Events?: Array<{ event: string; props: Record<string, unknown> }> };
const win = window as unknown as Sink;

describe('the dev-only v3 event sink', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    win.__v3Events = [];
  });
  afterEach(() => {
    delete win.__v3Events;
    vi.unstubAllEnvs();
  });

  it('pushes each v3 funnel event, with its props, when the page asks for them, even with analytics off', () => {
    trackFunnel('v3_choice_made', { tenantId: 't1', userId: 'u1' }, { choice_key: 'greeting', answer_mode: 'tap' });
    expect(win.__v3Events).toEqual([
      {
        event: 'v3_choice_made',
        props: expect.objectContaining({ tenant_id: 't1', user_id: 'u1', source: 'web', choice_key: 'greeting', answer_mode: 'tap' }),
      },
    ]);
  });

  it('keeps only the v3 events', () => {
    track('tour_started');
    trackFunnel('wizard_started', {});
    trackFunnel('v3_first_heard', {}, { source: 'server' });
    expect(win.__v3Events?.map((e) => e.event)).toEqual(['v3_first_heard']);
  });

  it('does nothing when the page did not ask (no sink defined)', () => {
    delete win.__v3Events;
    expect(() => trackFunnel('v3_turn_viewed', {}, { choice_key: 'greeting' })).not.toThrow();
    expect(win.__v3Events).toBeUndefined();
  });

  it('is off in a production build, sink or not', () => {
    vi.stubEnv('DEV', false);
    trackFunnel('v3_choice_made', {}, { answer_mode: 'tap' });
    expect(win.__v3Events).toEqual([]);
  });
});
