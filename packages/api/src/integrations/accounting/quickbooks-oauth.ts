import { ValidationError } from '../../shared/errors';

/**
 * Intuit QuickBooks Online OAuth + token refresh (node-fetch, no SDK).
 */

export interface QuickBooksOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** sandbox vs production — defaults from env. */
  environment?: 'sandbox' | 'production';
}

export type QuickBooksFetch = typeof fetch;

export const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

export function buildQuickBooksAuthUrl(config: QuickBooksOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: QBO_SCOPE,
    state,
  });
  return `${INTUIT_AUTH_URL}?${params.toString()}`;
}

export interface ExchangedQuickBooksTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  realmId: string;
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeQuickBooksAuthorizationCode(
  config: QuickBooksOAuthConfig,
  code: string,
  realmId: string,
  fetchFn: QuickBooksFetch = fetch,
): Promise<ExchangedQuickBooksTokens> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });
  const res = await fetchFn(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponseBody;
  if (!res.ok || !json.access_token || !json.refresh_token) {
    throw new ValidationError(
      json.error_description ?? json.error ?? 'QuickBooks token exchange failed',
    );
  }
  if (!realmId) {
    throw new ValidationError('QuickBooks realmId is required');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSec: json.expires_in ?? 3600,
    realmId,
  };
}

export async function refreshQuickBooksTokens(
  config: QuickBooksOAuthConfig,
  refreshToken: string,
  fetchFn: QuickBooksFetch = fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetchFn(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponseBody;
  if (!res.ok || !json.access_token) {
    throw new ValidationError(
      json.error_description ?? json.error ?? 'QuickBooks token refresh failed',
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
  };
}

export function quickBooksApiBase(environment: 'sandbox' | 'production' = 'production'): string {
  return environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
    : 'https://quickbooks.api.intuit.com/v3/company';
}

export function resolveQuickBooksEnvironment(): 'sandbox' | 'production' {
  const env = process.env.QUICKBOOKS_ENVIRONMENT?.toLowerCase();
  if (env === 'sandbox') return 'sandbox';
  return 'production';
}

export function resolveQuickBooksOAuthConfig(apiBaseUrl: string): QuickBooksOAuthConfig | undefined {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const redirectUri =
    process.env.QUICKBOOKS_REDIRECT_URI ??
    `${apiBaseUrl.replace(/\/$/, '')}/api/integrations/quickbooks/callback`;
  return {
    clientId,
    clientSecret,
    redirectUri,
    environment: resolveQuickBooksEnvironment(),
  };
}
