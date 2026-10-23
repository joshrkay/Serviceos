import {
  oauthStateCookieName,
  type OAuthBindingProvider,
} from '../../src/integrations/oauth-state-binding';

/**
 * The Cookie header the browser that started an OAuth flow sends back to the
 * callback: the connect route's binding cookie holding `state`. Tests that
 * mint a state directly in the repo use it to stand in for that browser.
 */
export function oauthBindingCookie(
  provider: OAuthBindingProvider,
  state: string,
  webOrigin = 'https://app.example.com',
): string {
  return `${oauthStateCookieName(provider, webOrigin)}=${state}`;
}
