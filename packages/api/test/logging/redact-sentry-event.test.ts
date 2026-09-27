/**
 * #1205 item 2 — Sentry's `beforeSend` runs strict redaction over the whole
 * event, including `tags` and stack frames. `/tenant/i` masked the tenant_id
 * tag (so events couldn't be filtered by tenant) and `/name/i` masked every
 * frame's `filename`. Tags are only ever set from already-redacted sources
 * (capture-server-error.ts), and a source filename is a code path, not PII.
 */
import { describe, it, expect } from 'vitest';
import { redactSentryEvent } from '../../src/logging/redact';

describe('redactSentryEvent (#1205)', () => {
  const event = {
    tags: { tenant_id: '11111111-1111-4111-8111-111111111111', route: '/api/jobs/:id' },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [{ filename: '/app/packages/api/src/routes/jobs.ts', function: 'handler' }],
          },
        },
      ],
    },
    user: { email: 'owner@example.com' },
    extra: { customerName: 'Jane Doe' },
  };

  it('keeps the tenant_id tag filterable', () => {
    const out = redactSentryEvent(event) as typeof event;
    expect(out.tags.tenant_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(out.tags.route).toBe('/api/jobs/:id');
  });

  it('keeps stack-frame filenames', () => {
    const out = redactSentryEvent(event) as typeof event;
    expect(out.exception.values[0].stacktrace.frames[0].filename).toBe(
      '/app/packages/api/src/routes/jobs.ts',
    );
  });

  it('still masks real PII elsewhere in the event', () => {
    const out = redactSentryEvent(event) as typeof event;
    expect(out.user.email).not.toBe('owner@example.com');
    expect(out.extra.customerName).not.toBe('Jane Doe');
  });
});
