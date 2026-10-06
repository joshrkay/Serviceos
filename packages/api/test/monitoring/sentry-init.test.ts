import { describe, it, expect, afterEach } from 'vitest';
import { initSentry } from '../../src/monitoring/sentry';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sentry = require('@sentry/node');

describe('initSentry — Sentry 11 dataCollection is explicit and conservative', () => {
  afterEach(async () => {
    await Sentry.close();
  });

  it('opts out of every default-on collection channel (bodies, headers, cookies, IP/user, queries, AI I/O, local vars)', () => {
    initSentry({ dsn: 'https://test@sentry.io/123', environment: 'test' });

    const dc = Sentry.getClient().getOptions().dataCollection;
    expect(dc.httpBodies).toEqual([]);
    expect(dc.httpHeaders).toEqual({ request: false, response: false });
    expect(dc.cookies).toBe(false);
    expect(dc.userInfo).toBe(false);
    expect(dc.urlQueryParams).toBe(false);
    expect(dc.graphQL).toEqual({ document: false, variables: false });
    expect(dc.genAI).toEqual({ inputs: false, outputs: false });
    expect(dc.databaseQueryData).toBe(false);
    expect(dc.queues).toBe(false);
    expect(dc.stackFrameVariables).toBe(false);
  });
});
