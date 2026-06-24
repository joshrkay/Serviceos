/**
 * Shared non-enum types for the AI Service OS platform.
 *
 * Per the freeze-list, `packages/shared/src/enums.ts` is Tier-1 LOCKED.
 * This file holds shared *types* (string-union literal types, response
 * shapes, etc.) that are too narrow to deserve enum membership but still
 * cross the api/web boundary or otherwise need to live in one place.
 *
 * P12-001 introduces the `Mode` type and the `MeResponse` shape consumed
 * by `GET /api/me`.
 */

/**
 * Operator mode for an authenticated user.
 *
 * - `supervisor`: the operator is at the desk, available to approve
 *   proposals interactively.
 * - `tech`: the operator is in the field; AI should queue proposals and
 *   surface them via SMS / push.
 * - `both`: dual presence — used when a single owner-operator is briefly
 *   wearing both hats and wants the AI to behave as if a supervisor is
 *   reachable.
 *
 * Note: `unsupervised` is *not* a member of `Mode`. It only appears on
 * `voice_sessions.supervisor_mode_at_start` to record sessions that ran
 * without any supervisor backing.
 */
export type Mode = 'supervisor' | 'tech' | 'both';

/**
 * Response shape for `GET /api/me`. The backend derives `permissions`
 * from `rbac.ts` so the frontend can render guards without re-implementing
 * the role → permission map.
 */
export interface MeResponse {
  user_id: string;
  tenant_id: string;
  role: string;
  can_field_serve: boolean;
  current_mode: Mode;
  mode_changed_at: string | null;
  permissions: string[];
  backup_supervisor_user_id: string | null;
  unsupervised_proposal_routing:
    | 'queue_and_sms'
    | 'queue_only'
    | 'escalate_to_oncall';
  /**
   * The tenant's entity-label overrides (e.g. `{ estimateTerm: 'Quote' }`)
   * from `tenant_settings.terminology_preferences`. Surfaced on the
   * bootstrap call so the web client can render the tenant's own words
   * everywhere via the shared terminology resolver (story 2.5). Absent
   * keys fall back to the platform defaults. Optional: legacy callers and
   * the timezone-only `/api/me` consumers ignore it.
   */
  terminology_preferences?: Record<string, string>;
}
