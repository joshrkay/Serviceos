export type SendgridFailureCode = 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'UNKNOWN';

export type SendgridProvisioningResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: { code: SendgridFailureCode; message: string; retriable: boolean; providerCode?: string } };

function classifySendgridError(error: unknown): SendgridProvisioningResult<never>['failure'] {
  const e = error as { code?: string | number; message?: string; status?: number };
  const status = e.status ?? 0;
  if (status === 401 || status === 403) return { code: 'AUTH', message: e.message ?? 'Unauthorized', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 404) return { code: 'NOT_FOUND', message: e.message ?? 'Resource not found', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 409) return { code: 'CONFLICT', message: e.message ?? 'Conflict', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 429) return { code: 'RATE_LIMIT', message: e.message ?? 'Rate limited', retriable: true, providerCode: e.code ? String(e.code) : undefined };
  if (status >= 400 && status < 500) return { code: 'VALIDATION', message: e.message ?? 'Validation failed', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status >= 500) return { code: 'NETWORK', message: e.message ?? 'Provider unavailable', retriable: true, providerCode: e.code ? String(e.code) : undefined };
  return { code: 'UNKNOWN', message: e.message ?? 'Unknown SendGrid error', retriable: true, providerCode: e.code ? String(e.code) : undefined };
}

export type SendgridProvisioningClient = {
  createSubuser(input: { username: string; email: string; ips?: string[] }): Promise<{ id: number; username: string }>;
  createApiKey(input: { name: string; scopes: string[]; onBehalfOf: string }): Promise<{ apiKeyId: string; apiKey: string }>;
  storeScopedApiKey(input: { subuserId: number; apiKeyId: string; encryptedApiKey: string }): Promise<{ secretRef: string }>;
  createDomainAuthentication(input: { subuser: string; domain: string; automaticSecurity?: boolean }): Promise<{ id: number; domain: string; dnsRecords: Array<{ type: string; host: string; value: string }> }>;
  createVerifiedSender(input: { subuser: string; fromEmail: string; fromName: string; replyTo?: string }): Promise<{ id: number; fromEmail: string; verified: boolean }>;
  assignIpPool?(input: { subuser: string; ipPoolName: string }): Promise<{ pool: string }>;
};

export async function createSendgridSubuser(client: SendgridProvisioningClient, input: { username: string; email: string; ips?: string[] }): Promise<SendgridProvisioningResult<{ subuserId: number; username: string }>> {
  try {
    const created = await client.createSubuser(input);
    return { ok: true, value: { subuserId: created.id, username: created.username } };
  } catch (error) {
    return { ok: false, failure: classifySendgridError(error) };
  }
}

export async function createAndStoreScopedApiKey(client: SendgridProvisioningClient, input: { name: string; scopes: string[]; onBehalfOf: string; subuserId: number; encrypt: (rawKey: string) => Promise<string> }): Promise<SendgridProvisioningResult<{ apiKeyId: string; secretRef: string }>> {
  try {
    const apiKey = await client.createApiKey({ name: input.name, scopes: input.scopes, onBehalfOf: input.onBehalfOf });
    const encrypted = await input.encrypt(apiKey.apiKey);
    const stored = await client.storeScopedApiKey({ subuserId: input.subuserId, apiKeyId: apiKey.apiKeyId, encryptedApiKey: encrypted });
    return { ok: true, value: { apiKeyId: apiKey.apiKeyId, secretRef: stored.secretRef } };
  } catch (error) {
    return { ok: false, failure: classifySendgridError(error) };
  }
}

export async function createSendgridDomainAuthentication(client: SendgridProvisioningClient, input: { subuser: string; domain: string; automaticSecurity?: boolean }): Promise<SendgridProvisioningResult<{ domainAuthId: number; domain: string; dnsRecords: Array<{ type: string; host: string; value: string }> }>> {
  try {
    const auth = await client.createDomainAuthentication(input);
    return { ok: true, value: { domainAuthId: auth.id, domain: auth.domain, dnsRecords: auth.dnsRecords } };
  } catch (error) {
    return { ok: false, failure: classifySendgridError(error) };
  }
}

export async function createSendgridVerifiedSender(client: SendgridProvisioningClient, input: { subuser: string; fromEmail: string; fromName: string; replyTo?: string }): Promise<SendgridProvisioningResult<{ senderId: number; fromEmail: string; verified: boolean }>> {
  try {
    const sender = await client.createVerifiedSender(input);
    return { ok: true, value: { senderId: sender.id, fromEmail: sender.fromEmail, verified: sender.verified } };
  } catch (error) {
    return { ok: false, failure: classifySendgridError(error) };
  }
}

export async function assignOptionalIpPool(client: SendgridProvisioningClient, input: { subuser: string; ipPoolName: string }): Promise<SendgridProvisioningResult<{ assigned: boolean; ipPoolName?: string }>> {
  if (!client.assignIpPool) {
    return { ok: true, value: { assigned: false } };
  }

  try {
    const result = await client.assignIpPool(input);
    return { ok: true, value: { assigned: true, ipPoolName: result.pool } };
  } catch (error) {
    return { ok: false, failure: classifySendgridError(error) };
  }
}
