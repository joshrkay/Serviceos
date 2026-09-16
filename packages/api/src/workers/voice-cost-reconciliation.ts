import { randomUUID } from "node:crypto";
import type { VoiceUsageCostRepository } from "../billing/voice-usage-cost";
import {
  deepgramCostMicroCents,
  twilioPriceToMicroCents,
} from "../billing/provider-costs";

export async function runVoiceCostReconciliationSweep(deps: {
  tenantIds: string[];
  repo: Pick<
    VoiceUsageCostRepository,
    "findDueTwilio" | "record" | "completeTwilio" | "deferTwilio"
  >;
  resolveAuthToken(accountSid: string): Promise<string | undefined>;
  fetchFn?: typeof fetch;
  mediaStreamsCentsPerHour: number;
  now?: Date;
}): Promise<{ completed: number; deferred: number }> {
  const now = deps.now ?? new Date();
  const fetchFn = deps.fetchFn ?? fetch;
  let completed = 0;
  let deferred = 0;
  for (const tenantId of deps.tenantIds) {
    for (const row of await deps.repo.findDueTwilio(tenantId, now)) {
      try {
        const token = await deps.resolveAuthToken(row.accountSid);
        if (!token) throw new Error("Twilio auth token unavailable");
        const basic = Buffer.from(`${row.accountSid}:${token}`).toString(
          "base64",
        );
        const res = await fetchFn(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(row.accountSid)}/Calls/${encodeURIComponent(row.callSid)}.json`,
          {
            headers: { Authorization: `Basic ${basic}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok)
          throw new Error(`Twilio call lookup failed (${res.status})`);
        const data = (await res.json()) as { price?: string | null };
        const callCost = twilioPriceToMicroCents(data.price);
        if (callCost === null) throw new Error("Twilio price not finalized");
        if (
          row.mediaStreamsUsed &&
          (!Number.isFinite(deps.mediaStreamsCentsPerHour) ||
            deps.mediaStreamsCentsPerHour < 0)
        ) {
          throw new Error("Twilio Media Streams contracted rate unavailable");
        }
        const streamCost = row.mediaStreamsUsed
          ? deepgramCostMicroCents(
              row.usageSeconds,
              deps.mediaStreamsCentsPerHour,
            )
          : 0;
        await deps.repo.record({
          id: randomUUID(),
          tenantId,
          sessionId: row.sessionId,
          sourceId: row.callSid,
          provider: "twilio",
          usageSeconds: row.usageSeconds,
          providerCostMicroCents: callCost + streamCost,
          occurredAt: row.occurredAt,
        });
        await deps.repo.completeTwilio(tenantId, row.id);
        completed++;
      } catch (error) {
        const delayMinutes = Math.min(24 * 60, 2 ** Math.min(row.attempts, 10));
        await deps.repo.deferTwilio(
          tenantId,
          row.id,
          error instanceof Error ? error.message : String(error),
          new Date(now.getTime() + delayMinutes * 60_000),
        );
        deferred++;
      }
    }
  }
  return { completed, deferred };
}
