import { samePhone } from "../voice/activation";

/**
 * Billable-call classification and the per-call usage ledger.
 *
 * A call is billable when the AI answered it, it lasted at least 30 seconds,
 * and the caller is not the business's own owner/business phone. Transfers
 * and message-taking still count — the AI did the work.
 */
export interface CallFacts {
  channel: "voice_inbound" | "inapp_voice";
  usageSeconds: number;
  callerPhone?: string;
}

export interface TenantPhones {
  ownerPhone?: string | null;
  businessPhone?: string | null;
}

export type CallClassification =
  | { billable: true }
  | { billable: false; reason: "not_inbound_call" | "under_30_seconds" | "own_number" };

export const MIN_BILLABLE_CALL_SECONDS = 30;

export function classifyCall(
  call: CallFacts,
  phones: TenantPhones,
): CallClassification {
  if (call.channel !== "voice_inbound") {
    return { billable: false, reason: "not_inbound_call" };
  }
  if (
    samePhone(call.callerPhone, phones.ownerPhone) ||
    samePhone(call.callerPhone, phones.businessPhone)
  ) {
    return { billable: false, reason: "own_number" };
  }
  if (call.usageSeconds < MIN_BILLABLE_CALL_SECONDS) {
    return { billable: false, reason: "under_30_seconds" };
  }
  return { billable: true };
}
