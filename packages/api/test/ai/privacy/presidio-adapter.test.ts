import { describe, expect, it, vi } from 'vitest';
import {
  HttpPresidioClient,
  PresidioUnavailableError,
  createPresidioAnonymizer,
} from '../../../src/ai/privacy/presidio-adapter';

/**
 * WS5 — Presidio adapter unit tests. The HTTP layer is fully mocked (injected
 * `fetchFn`), so no real Presidio service is contacted. Covers the success
 * pipeline (analyze → anonymize), entity mapping, and every fail-closed mode:
 * non-2xx, network/timeout, and malformed JSON on either endpoint.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeClient(fetchFn: typeof fetch): HttpPresidioClient {
  return new HttpPresidioClient({
    analyzerUrl: 'http://analyzer:3000',
    anonymizerUrl: 'http://anonymizer:3000',
    fetchFn,
    timeoutMs: 1000,
  });
}

describe('HttpPresidioClient', () => {
  it('runs analyze then anonymize and returns anonymized text + mapped entities', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/analyze')) {
        return jsonResponse([
          { entity_type: 'PERSON', start: 0, end: 10, score: 0.99 },
          { entity_type: 'PHONE_NUMBER', start: 20, end: 32, score: 0.85 },
        ]);
      }
      if (u.endsWith('/anonymize')) {
        return jsonResponse({ text: '[PERSON] called [PHONE_NUMBER] today' });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const client = makeClient(fetchFn as unknown as typeof fetch);
    const result = await client.anonymize('Sarah Jones called 415-555-0123 today');

    expect(result.anonymizedText).toBe('[PERSON] called [PHONE_NUMBER] today');
    expect(result.entities).toEqual([
      { entityType: 'PERSON', start: 0, end: 10, score: 0.99 },
      { entityType: 'PHONE_NUMBER', start: 20, end: 32, score: 0.85 },
    ]);
    // analyze + anonymize = 2 round trips.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('builds a per-entity-type replace anonymizer request body', async () => {
    let anonymizeBody: Record<string, unknown> | undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/analyze')) {
        return jsonResponse([{ entity_type: 'EMAIL_ADDRESS', start: 0, end: 15, score: 0.9 }]);
      }
      anonymizeBody = JSON.parse(String(init?.body));
      return jsonResponse({ text: '[EMAIL_ADDRESS]' });
    });

    const client = makeClient(fetchFn as unknown as typeof fetch);
    await client.anonymize('a@example.com!!');

    expect(anonymizeBody?.anonymizers).toMatchObject({
      EMAIL_ADDRESS: { type: 'replace', new_value: '[EMAIL_ADDRESS]' },
    });
    expect(anonymizeBody?.analyzer_results).toEqual([
      { entity_type: 'EMAIL_ADDRESS', start: 0, end: 15, score: 0.9 },
    ]);
  });

  it('skips the anonymize round trip when analyze finds nothing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse([]));
    const client = makeClient(fetchFn as unknown as typeof fetch);

    const result = await client.anonymize('the water heater is fine');

    expect(result.anonymizedText).toBe('the water heater is fine');
    expect(result.entities).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a non-2xx analyze response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'boom' }, 503));
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('fails closed on a non-2xx anonymize response', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/analyze')) {
        return jsonResponse([{ entity_type: 'PERSON', start: 0, end: 11, score: 0.9 }]);
      }
      return jsonResponse({ error: 'boom' }, 500);
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('fails closed on a network error / timeout (rejected fetch)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('fails closed on malformed JSON from analyze', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      text: async () => 'not json',
    } as unknown as Response));
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('fails closed when analyze returns a non-array body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ not: 'an array' }));
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('fails closed when analyze returns a malformed span', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([{ entity_type: 'PERSON', start: 'oops', end: 10, score: 0.9 }]),
    );
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it.each([
    ['negative start', { entity_type: 'PERSON', start: -1, end: 10, score: 0.9 }],
    ['end before start', { entity_type: 'PERSON', start: 10, end: 3, score: 0.9 }],
    ['missing score', { entity_type: 'PERSON', start: 0, end: 10 }],
    ['NaN score', { entity_type: 'PERSON', start: 0, end: 10, score: Number.NaN }],
  ])('fails closed on an out-of-bounds span (%s)', async (_label, span) => {
    const fetchFn = vi.fn(async () => jsonResponse([span]));
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });

  it('short-circuits empty / whitespace-only input without any HTTP call', async () => {
    const fetchFn = vi.fn();
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('')).resolves.toEqual({
      anonymizedText: '',
      entities: [],
    });
    await expect(client.anonymize('   \n\t')).resolves.toEqual({
      anonymizedText: '   \n\t',
      entities: [],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps a hostile entity_type ("__proto__") from polluting the anonymizer map', async () => {
    let anonymizeBody: Record<string, unknown> | undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/analyze')) {
        return jsonResponse([{ entity_type: '__proto__', start: 0, end: 5, score: 0.9 }]);
      }
      anonymizeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ text: '[__proto__] here' });
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);

    const result = await client.anonymize('Sarah here');
    expect(result.anonymizedText).toBe('[__proto__] here');
    // The prototype-less dictionary carries the key as plain data…
    const anonymizers = anonymizeBody?.anonymizers as Record<string, unknown>;
    expect(anonymizers['__proto__']).toEqual({ type: 'replace', new_value: '[__proto__]' });
    // …and Object.prototype was not polluted in the process.
    expect(({} as Record<string, unknown>).new_value).toBeUndefined();
  });

  it('fails closed when anonymize returns a body without text', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/analyze')) {
        return jsonResponse([{ entity_type: 'PERSON', start: 0, end: 11, score: 0.9 }]);
      }
      return jsonResponse({ items: [] });
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);

    await expect(client.anonymize('Sarah Jones')).rejects.toBeInstanceOf(
      PresidioUnavailableError,
    );
  });
});

describe('createPresidioAnonymizer', () => {
  it('returns null when either URL is missing', () => {
    expect(createPresidioAnonymizer({})).toBeNull();
    expect(
      createPresidioAnonymizer({ PRESIDIO_ANALYZER_URL: 'http://a:3000' }),
    ).toBeNull();
    expect(
      createPresidioAnonymizer({ PRESIDIO_ANONYMIZER_URL: 'http://b:3000' }),
    ).toBeNull();
  });

  it('treats whitespace-only URLs as unconfigured and trims real ones', () => {
    expect(
      createPresidioAnonymizer({
        PRESIDIO_ANALYZER_URL: '   ',
        PRESIDIO_ANONYMIZER_URL: 'http://b:3000',
      }),
    ).toBeNull();
    expect(
      createPresidioAnonymizer({
        PRESIDIO_ANALYZER_URL: ' http://a:3000 ',
        PRESIDIO_ANONYMIZER_URL: ' http://b:3000 ',
      }),
    ).toBeInstanceOf(HttpPresidioClient);
  });

  it('returns a client when both URLs are configured', () => {
    const client = createPresidioAnonymizer({
      PRESIDIO_ANALYZER_URL: 'http://a:3000',
      PRESIDIO_ANONYMIZER_URL: 'http://b:3000',
    });
    expect(client).toBeInstanceOf(HttpPresidioClient);
  });
});
