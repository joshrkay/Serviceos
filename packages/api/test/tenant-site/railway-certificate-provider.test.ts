/**
 * D-046 / #1770 — the Railway custom-domain provider: inert without its
 * configuration, and speaks the GraphQL calls with a mocked fetch.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RailwayCertificateProvider,
  createRailwayCertificateProvider,
  mapRailwayCertificateStatus,
} from '../../src/tenant-site/railway-certificate-provider';

const FULL_ENV = {
  RAILWAY_API_TOKEN: 'tok',
  RAILWAY_PROJECT_ID: 'proj',
  RAILWAY_ENVIRONMENT_ID: 'env',
  TENANT_SITE_RAILWAY_SERVICE_ID: 'svc',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createRailwayCertificateProvider', () => {
  it('is inert unless every value is configured', () => {
    expect(createRailwayCertificateProvider({})).toBeNull();
    for (const key of Object.keys(FULL_ENV)) {
      expect(createRailwayCertificateProvider({ ...FULL_ENV, [key]: undefined }), key).toBeNull();
    }
    expect(createRailwayCertificateProvider(FULL_ENV)).toBeInstanceOf(RailwayCertificateProvider);
  });
});

describe('mapRailwayCertificateStatus', () => {
  it('maps Railway statuses to issued / pending / failed', () => {
    expect(mapRailwayCertificateStatus('CERTIFICATE_STATUS_TYPE_VALID')).toBe('issued');
    expect(mapRailwayCertificateStatus('CERTIFICATE_STATUS_TYPE_ISSUING_FAILED')).toBe('failed');
    expect(mapRailwayCertificateStatus('CERTIFICATE_STATUS_TYPE_PENDING')).toBe('pending');
    expect(mapRailwayCertificateStatus(undefined)).toBe('pending');
  });
});

describe('RailwayCertificateProvider', () => {
  function make(handler: (body: { query: string; variables: Record<string, unknown> }) => Response) {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      handler(JSON.parse(String(init?.body))),
    ) as unknown as typeof fetch;
    const provider = createRailwayCertificateProvider(FULL_ENV, { endpoint: 'https://railway.test/graphql', fetchImpl });
    return { provider: provider!, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
  }

  it('registers a domain on the serving service and returns the Railway id', async () => {
    const { provider, fetchImpl } = make(() => jsonResponse({ data: { customDomainCreate: { id: 'cd-1' } } }));
    expect(await provider.register('www.joesplumbing.test')).toEqual({ ref: 'cd-1' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://railway.test/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body)).variables.input).toEqual({
      domain: 'www.joesplumbing.test',
      projectId: 'proj',
      environmentId: 'env',
      serviceId: 'svc',
    });
  });

  it('reads the certificate status, and treats a vanished domain as failed', async () => {
    const valid = make(() => jsonResponse({ data: { customDomain: { status: { certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID' } } } }));
    expect(await valid.provider.status('d', 'cd-1')).toBe('issued');
    const gone = make(() => jsonResponse({ data: { customDomain: null } }));
    expect(await gone.provider.status('d', 'cd-1')).toBe('failed');
  });

  it('removes a domain', async () => {
    const { provider, fetchImpl } = make(() => jsonResponse({ data: { customDomainDelete: true } }));
    await provider.remove('d', 'cd-1');
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)).variables).toEqual({ id: 'cd-1' });
  });

  it('surfaces HTTP and GraphQL errors', async () => {
    await expect(make(() => jsonResponse({}, 502)).provider.register('d')).rejects.toThrow(/502/);
    await expect(
      make(() => jsonResponse({ errors: [{ message: 'Not Authorized' }] })).provider.register('d'),
    ).rejects.toThrow(/Not Authorized/);
  });
});
