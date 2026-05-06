import { ValidationError } from '../shared/errors';
import {
  CalendarIntegrationRepository,
  decryptAccessToken,
  decryptRefreshToken,
  encryptToken,
  CalendarIntegration,
} from './calendar-integration';

/**
 * Tier 4 (Calendar sync — PR 1). Google OAuth + Calendar API client.
 *
 * Three responsibilities:
 *   1. Build the consent URL the operator gets redirected to.
 *   2. Exchange the code returned by Google for tokens.
 *   3. Refresh expired access tokens transparently.
 *
 * Calendar event push lives outside this file (the worker hooks into
 * appointment.created and calls a small event-shape helper). PR 1
 * scope is just the connection lifecycle.
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleFetch = typeof fetch;

const SCOPES = [
  // We need r/w on calendar events + read on the user's email
  // (so we can display the connected account in the UI).
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function buildGoogleAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    // 'offline' grants a refresh_token; 'consent' forces the consent
    // screen even when the user previously authorized — Google
    // otherwise returns no refresh_token on subsequent flows, which
    // breaks our long-lived integration model.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email: string;
}

/**
 * Exchanges the auth code for tokens + the user's email. The email
 * is fetched from /userinfo (OpenID Connect endpoint) because the
 * raw token response doesn't include it for the calendar scope.
 */
export async function exchangeAuthorizationCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchFn: GoogleFetch = fetch,
): Promise<ExchangedTokens> {
  const tokenRes = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${body}`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokenJson.access_token || !tokenJson.refresh_token) {
    // No refresh_token typically means the user previously authorized
    // and Google reused the existing grant. We force prompt=consent
    // above to avoid this, but if it happens the caller can't refresh
    // later — fail loudly instead of persisting a half-broken row.
    throw new Error('Google did not return access + refresh tokens');
  }

  const userinfoRes = await fetchFn(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userinfoRes.ok) {
    const body = await userinfoRes.text();
    throw new Error(`Google userinfo fetch failed (${userinfoRes.status}): ${body}`);
  }
  const userinfo = (await userinfoRes.json()) as { email?: string };
  if (!userinfo.email) {
    throw new Error('Google userinfo did not include email');
  }

  const expiresIn = tokenJson.expires_in ?? 3600;
  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    email: userinfo.email,
  };
}

/**
 * Returns a non-expired access token for the integration, refreshing
 * via Google when the cached one is within 60s of expiry. Persists
 * the refreshed token onto the row so the next call doesn't re-refresh.
 *
 * On 'invalid_grant' (refresh token revoked by the user), flips the
 * integration to status='expired' and throws — the UI prompts the
 * operator to reconnect.
 */
export async function getValidAccessToken(
  integration: CalendarIntegration,
  config: GoogleOAuthConfig,
  repo: CalendarIntegrationRepository,
  fetchFn: GoogleFetch = fetch,
): Promise<string> {
  const buffer = 60 * 1000;
  if (integration.accessTokenExpiresAt.getTime() - Date.now() > buffer) {
    return decryptAccessToken(integration);
  }

  const refreshToken = decryptRefreshToken(integration);
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401) {
      // invalid_grant — the user revoked the connection on Google's
      // side (or admin-disabled the OAuth client). Mark the integration
      // expired so the UI can surface a "reconnect" prompt.
      await repo.setStatus(integration.id, 'expired');
      throw new ValidationError(
        'Google calendar connection has expired — please reconnect',
      );
    }
    throw new Error(`Google token refresh failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error('Google token refresh returned no access_token');
  }
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
  await repo.updateAccessToken(integration.id, encryptToken(json.access_token), expiresAt);
  return json.access_token;
}
