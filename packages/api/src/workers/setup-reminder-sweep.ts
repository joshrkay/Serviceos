/**
 * Setup-reminder sweep.
 *
 * Mirrors the P0-009 cross-tenant sweep idiom (thank-you-sms-worker): a single
 * eligibility SELECT, per-tenant try/catch, no-DB no-op, injectable clock.
 *
 * Eligibility: tenants created at least `minAgeHours` ago (default 24) that
 *   1. have NOT yet been sent a setup_reminder (no lifecycle_emails row), and
 *   2. have not activated (tenant_settings.activated_at IS NULL — a cheap
 *      pre-filter; a fully-activated tenant is certainly done).
 * For each candidate we load the real onboarding facts and re-check
 * completeness with the same `deriveOnboardingStatus` the UI uses. If still
 * incomplete we send the reminder listing the outstanding steps; if it turns
 * out complete we stamp the ledger WITHOUT sending so the sweep stops
 * re-evaluating it.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { renderSetupReminderEmail } from '../notifications/templates';
import {
  sendLifecycleEmail,
  claimLifecycleEmail,
} from '../notifications/lifecycle-email';
import { loadOnboardingFacts } from '../onboarding/load-facts';
import { deriveOnboardingStatus } from '../onboarding/derive-status';
import type { OnboardingStepId } from '../onboarding/contracts';

const HOUR_MS = 60 * 60 * 1000;

/** Human labels for the steps a reminder can list as outstanding. */
const STEP_LABELS: Record<OnboardingStepId, string> = {
  signup: 'Create your account',
  identity: 'Add your business details',
  pack: 'Pick your trade (HVAC or plumbing)',
  phone: 'Forward your phone line to Rivet',
  billing: 'Start your free trial',
  ai_check: 'Let Rivet check your AI voice setup',
  test_call: 'Make a test call to confirm it works',
};

export interface SetupReminderSweepDeps {
  pool: Pool | null;
  settingsRepo: SettingsRepository;
  delivery: MessageDeliveryProvider | null;
  auditRepo?: AuditRepository;
  appBaseUrl: string;
  supportEmail: string;
  logger: Logger;
  now?: () => Date;
  /** Minimum tenant age before the reminder fires. Default 24h. */
  minAgeHours?: number;
}

export interface SetupReminderSweepResult {
  candidates: number;
  sent: number;
  /** Candidates that turned out complete — ledger stamped, no email. */
  suppressed: number;
  failed: number;
}

interface CandidateRow {
  tenant_id: string;
  owner_email: string | null;
}

const ELIGIBLE_SQL = `
  SELECT t.id AS tenant_id, t.owner_email
    FROM tenants t
    LEFT JOIN lifecycle_emails le
      ON le.tenant_id = t.id AND le.kind = 'setup_reminder'
    LEFT JOIN tenant_settings ts
      ON ts.tenant_id = t.id
   WHERE t.created_at <= $1
     AND le.tenant_id IS NULL
     AND ts.activated_at IS NULL
   ORDER BY t.created_at ASC
   LIMIT 500
`;

export async function runSetupReminderSweep(
  deps: SetupReminderSweepDeps,
): Promise<SetupReminderSweepResult> {
  const result: SetupReminderSweepResult = {
    candidates: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
  };
  if (!deps.pool) return result;

  const now = deps.now ?? (() => new Date());
  const minAgeHours = deps.minAgeHours ?? 24;
  const createdBefore = new Date(now().getTime() - minAgeHours * HOUR_MS);

  let rows: CandidateRow[];
  try {
    const res = await deps.pool.query<CandidateRow>(ELIGIBLE_SQL, [createdBefore]);
    rows = res.rows;
  } catch (err) {
    deps.logger.error('Setup-reminder sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;

  for (const row of rows) {
    try {
      const outcome = await handleCandidate(deps, row);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'suppressed') result.suppressed++;
    } catch (err) {
      result.failed++;
      deps.logger.warn('Setup-reminder sweep: tenant failed', {
        tenantId: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function handleCandidate(
  deps: SetupReminderSweepDeps,
  row: CandidateRow,
): Promise<'sent' | 'suppressed'> {
  const pool = deps.pool!;
  const tenantId = row.tenant_id;

  const facts = await loadOnboardingFacts(
    { pool, settingsRepo: deps.settingsRepo },
    tenantId,
  );
  const status = deriveOnboardingStatus(facts);

  if (status.isComplete) {
    // Already done — stamp the ledger so we never re-evaluate this tenant.
    await claimLifecycleEmail(pool, tenantId, 'setup_reminder');
    return 'suppressed';
  }

  // No deliverable address → stamp + skip so the sweep doesn't loop forever.
  if (!row.owner_email) {
    await claimLifecycleEmail(pool, tenantId, 'setup_reminder');
    return 'suppressed';
  }

  const remainingSteps = status.steps
    .filter((s) => s.status !== 'done' && s.status !== 'skipped')
    .map((s) => STEP_LABELS[s.id]);

  const rendered = renderSetupReminderEmail({
    businessName: facts.identity.businessName ?? undefined,
    appBaseUrl: deps.appBaseUrl,
    supportEmail: deps.supportEmail,
    remainingSteps:
      remainingSteps.length > 0 ? remainingSteps : ['Finish your remaining setup steps'],
  });

  const outcome = await sendLifecycleEmail(
    { pool, delivery: deps.delivery, auditRepo: deps.auditRepo, logger: deps.logger },
    { tenantId, kind: 'setup_reminder', to: row.owner_email, rendered },
  );
  // 'duplicate'/'skipped' shouldn't happen (we pre-filtered + hold the row),
  // but treat anything other than a real send as suppressed for the tally.
  return outcome === 'sent' ? 'sent' : 'suppressed';
}
