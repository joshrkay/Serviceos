import { initClient, tsRestFetchApi, type ApiFetcherArgs } from '@ts-rest/core';
import { apiContract } from '@rivet/contracts';

const DEV_USER_KEY = 'rivet.devUserId';

export function getDevUserId(): string | null {
  return localStorage.getItem(DEV_USER_KEY);
}

export function setDevUserId(userId: string): void {
  localStorage.setItem(DEV_USER_KEY, userId);
}

export function clearDevUserId(): void {
  localStorage.removeItem(DEV_USER_KEY);
}

/**
 * Typed API client generated from the shared ts-rest contract. In dev-auth
 * mode the x-dev-user-id header identifies the user; with Clerk configured
 * this is where the Bearer token would be injected instead.
 */
export const api = initClient(apiContract, {
  baseUrl: '',
  api: async (args: ApiFetcherArgs) => {
    const devUserId = getDevUserId();
    if (devUserId) {
      args.headers['x-dev-user-id'] = devUserId;
    }
    const result = await tsRestFetchApi(args);
    if (result.status === 401 && window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    return result;
  },
});

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
