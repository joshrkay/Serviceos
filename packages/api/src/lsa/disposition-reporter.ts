/**
 * #1738 — optional report-back of lead disposition (booked / not booked /
 * spam) to Google LSA.
 *
 * Interface only: Google's LSA lead-feedback API needs a Google Ads manager
 * credential this slice does not have. `createLsaDispositionReporter` returns
 * a no-op unless BOTH the flag `LSA_DISPOSITION_REPORTING_ENABLED=true` is set
 * AND a client is supplied, so nothing is ever sent by default. The OAuth
 * follow-up supplies the client.
 */
import type { LsaDisposition } from './lsa-integration';

export interface LsaDispositionClient {
  report(args: {
    tenantId: string;
    externalLeadId: string;
    disposition: LsaDisposition;
  }): Promise<void>;
}

export interface LsaDispositionReporter {
  /** True only when a report was actually handed to the client. */
  report(args: {
    tenantId: string;
    externalLeadId: string;
    disposition: LsaDisposition;
  }): Promise<{ reported: boolean }>;
}

export const NOOP_LSA_DISPOSITION_REPORTER: LsaDispositionReporter = {
  async report() {
    return { reported: false };
  },
};

export function createLsaDispositionReporter(
  env: Record<string, string | undefined>,
  client?: LsaDispositionClient,
): LsaDispositionReporter {
  if (env.LSA_DISPOSITION_REPORTING_ENABLED !== 'true' || !client) {
    return NOOP_LSA_DISPOSITION_REPORTER;
  }
  return {
    async report(args) {
      await client.report(args);
      return { reported: true };
    },
  };
}
