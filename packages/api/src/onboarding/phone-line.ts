/**
 * #1563 — the tenant's business line as the owner sees it, derived from the
 * `tenant_integrations` twilio row. One read model shared by GET
 * /api/onboarding/phone (Settings → Phone) so the web never re-derives
 * provisioning state from raw provider_data.
 *
 * provider_data markers (all written by the phone routes / provisioning
 * worker, never by the client):
 *   awaitingPick  — checkout set up the subaccount + Messaging Service and
 *                   is waiting for the owner to pick a number;
 *   pendingPick   — a pick is in flight: the chosen E.164, or 'auto' for
 *                   "Pick one for me";
 *   pendingChange — a change-number to this E.164 is in flight;
 *   changeError   — why the last change-number did not happen (the tenant
 *                   kept its current number).
 */
export type PhoneLineState =
  | 'not_started'
  | 'setting_up'
  | 'awaiting_pick'
  | 'claiming'
  | 'active'
  | 'failed'
  | 'unavailable';

export interface PhoneLineView {
  state: PhoneLineState;
  phoneNumber: string | null;
  /** The number being claimed; null for "Pick one for me" or no claim. */
  pendingNumber: string | null;
  /** The number a change-number is moving to, while it runs. */
  changingTo: string | null;
  changeError: string | null;
  lastError: string | null;
}

export interface TwilioIntegrationRow {
  status: string;
  last_error: string | null;
  provider_data: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export const AUTO_PICK = 'auto';

export function toPhoneLineView(row: TwilioIntegrationRow | null | undefined): PhoneLineView {
  const pd = row?.provider_data ?? {};
  const phoneNumber = str(pd.phoneE164);
  const pendingPick = str(pd.pendingPick);
  const base = {
    phoneNumber,
    pendingNumber: null as string | null,
    changingTo: str(pd.pendingChange),
    changeError: str(pd.changeError),
    lastError: null as string | null,
  };
  if (!row) return { state: 'not_started', ...base };
  switch (row.status) {
    case 'full_readiness':
      return { state: 'active', ...base };
    case 'failed':
      return { state: 'failed', ...base, lastError: row.last_error };
    case 't0_requested':
      if (pendingPick) {
        return {
          state: 'claiming',
          ...base,
          pendingNumber: pendingPick === AUTO_PICK ? null : pendingPick,
        };
      }
      if (pd.awaitingPick === true) return { state: 'awaiting_pick', ...base };
      return { state: 'setting_up', ...base };
    default:
      return { state: 'unavailable', ...base };
  }
}
