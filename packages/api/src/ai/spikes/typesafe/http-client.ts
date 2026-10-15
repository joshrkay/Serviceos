import type { SystemOneClient, SystemOneRequest } from './system-one-client';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Minimal fetch client for POST /v1/systemone (docs.typesafe.ai/api). Spike use only. */
export function createHttpSystemOneClient(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): SystemOneClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async systemOne(req: SystemOneRequest) {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        throw new Error(`TypeSafe systemone request failed: HTTP ${res.status}`);
      }
      return (await res.json()) as Awaited<ReturnType<SystemOneClient['systemOne']>>;
    },
  };
}
