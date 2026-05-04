/**
 * P12-005 — typed wrapper for tenant settings PATCH.
 *
 * The backend route is `PUT /api/settings` (already extended in
 * P12-005-be). This wrapper is intentionally narrow — it accepts only
 * the Phase-12 fields. The existing review-URL save in SettingsPage
 * keeps its inline fetch; adopting this wrapper across the page is a
 * follow-up cleanup, not part of P12-005-fe.
 */

export type UnsupervisedProposalRouting =
  | 'queue_and_sms'
  | 'queue_only'
  | 'escalate_to_oncall';

export interface TenantSettingsModeUpdate {
  /** UUID, or null to explicitly clear the backup. */
  backupSupervisorUserId?: string | null;
  unsupervisedProposalRouting?: UnsupervisedProposalRouting;
}

export type AuthedFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * PUT /api/settings — partial update accepting any subset of the
 * extended schema. Throws on non-2xx; the toast layer is the caller's
 * responsibility.
 */
export async function updateTenantModeSettings(
  client: AuthedFetch,
  update: TenantSettingsModeUpdate,
): Promise<void> {
  const res = await client('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });

  if (res.ok) return;

  let detail = '';
  try {
    const body = await res.json();
    detail =
      typeof body?.message === 'string' ? body.message : JSON.stringify(body);
  } catch {
    /* non-JSON body */
  }

  throw new Error(
    `updateTenantModeSettings: ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`,
  );
}
