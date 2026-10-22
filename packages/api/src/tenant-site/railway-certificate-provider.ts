/**
 * D-046 / #1770 — the default CertificateProvider: Railway's custom-domain
 * GraphQL API. Registering a domain on the serving service makes Railway's edge
 * route it and issue its certificate.
 *
 * Inert unless configured: `createRailwayCertificateProvider` returns null
 * without RAILWAY_API_TOKEN (a project token), the project and environment ids
 * (Railway injects those into every service) and TENANT_SITE_RAILWAY_SERVICE_ID
 * (the id of the PUBLIC web service that serves the domains; the worker has a
 * different RAILWAY_SERVICE_ID, so that one is never used). Without them the
 * owner-facing "connect a domain" feature stays off.
 *
 * The request and response shapes follow Railway's public GraphQL schema as
 * documented; they have NOT been exercised against a live Railway project from
 * this code base. See D-046 for the caveats (per-service domain limits, and
 * whether Railway's DNS check follows the CNAME chain through the wildcard).
 */
import type { CertificateProvider, CertificateState } from './custom-domain';

const DEFAULT_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const REQUEST_TIMEOUT_MS = 10_000;

export interface RailwayProviderConfig {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/** Null (provider off) unless every Railway value is present. */
export function createRailwayCertificateProvider(
  env: {
    RAILWAY_API_TOKEN?: string | undefined;
    RAILWAY_PROJECT_ID?: string | undefined;
    RAILWAY_ENVIRONMENT_ID?: string | undefined;
    TENANT_SITE_RAILWAY_SERVICE_ID?: string | undefined;
  },
  overrides: Pick<RailwayProviderConfig, 'endpoint' | 'fetchImpl'> = {},
): CertificateProvider | null {
  const { RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, TENANT_SITE_RAILWAY_SERVICE_ID } = env;
  if (!RAILWAY_API_TOKEN || !RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !TENANT_SITE_RAILWAY_SERVICE_ID) return null;
  return new RailwayCertificateProvider({
    token: RAILWAY_API_TOKEN,
    projectId: RAILWAY_PROJECT_ID,
    environmentId: RAILWAY_ENVIRONMENT_ID,
    serviceId: TENANT_SITE_RAILWAY_SERVICE_ID,
    ...overrides,
  });
}

/** Maps Railway's certificate status enum (CERTIFICATE_STATUS_TYPE_*) to ours. */
export function mapRailwayCertificateStatus(status: unknown): CertificateState {
  const s = typeof status === 'string' ? status.toUpperCase() : '';
  if (s.includes('FAIL')) return 'failed';
  if (s.endsWith('VALID')) return 'issued';
  return 'pending';
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export class RailwayCertificateProvider implements CertificateProvider {
  readonly name = 'railway';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RailwayProviderConfig) {
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async call<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Railway API responded ${res.status}`);
    const body = (await res.json()) as GraphQlResponse<T>;
    if (body.errors?.length || !body.data) {
      throw new Error(`Railway API error: ${body.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    }
    return body.data;
  }

  async register(domain: string): Promise<{ ref: string }> {
    const data = await this.call<{ customDomainCreate: { id: string } }>(
      `mutation ($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id } }`,
      {
        input: {
          domain,
          projectId: this.config.projectId,
          environmentId: this.config.environmentId,
          serviceId: this.config.serviceId,
        },
      },
    );
    return { ref: data.customDomainCreate.id };
  }

  async status(_domain: string, ref: string): Promise<CertificateState> {
    const data = await this.call<{ customDomain: { status?: { certificateStatus?: string } } | null }>(
      `query ($id: String!, $projectId: String!) {
         customDomain(id: $id, projectId: $projectId) { status { certificateStatus } }
       }`,
      { id: ref, projectId: this.config.projectId },
    );
    // A domain Railway no longer knows is not coming; treat it as failed so the owner sees an error.
    if (!data.customDomain) return 'failed';
    return mapRailwayCertificateStatus(data.customDomain.status?.certificateStatus);
  }

  async remove(_domain: string, ref: string): Promise<void> {
    await this.call(`mutation ($id: String!) { customDomainDelete(id: $id) }`, { id: ref });
  }
}
