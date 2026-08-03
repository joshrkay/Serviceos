/**
 * Classify LLM / gateway failures on the voice path so we never speak
 * "I didn't catch that" (confidence_low) for infrastructure problems.
 *
 * Transient failures get one hold-line retry; repeated or hard failures
 * escalate via system_failure with an honest technical-issue line.
 */
import {
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
} from '../gateway/tenant-quota';
import { BreakerOpenError } from '../gateway/breaker';
import {
  ProviderRateLimitError,
  EmptyProviderResponseError,
  classifyError,
} from '../gateway/retry';

export type ClassifyInfraFailureKind =
  | 'quota_concurrency'
  | 'quota_budget'
  | 'breaker_open'
  | 'rate_limit'
  | 'timeout'
  | 'provider_transient'
  | 'unknown';

/** Spoken once after a transient infra failure — keep the call in intent_capture. */
export const AI_BUSY_HOLD_LINE =
  "One moment — we're a bit busy on this end. Could you please say that again?";

/**
 * Spoken when escalating after infra failure. Distinct from low-confidence
 * "trouble understanding" / "didn't catch that" copy.
 */
export const AI_INFRA_ESCALATE_REASON_PREFIX = 'ai_infrastructure:';

export function classifyInfraFailure(err: unknown): ClassifyInfraFailureKind {
  if (err instanceof TenantConcurrencyExceededError) return 'quota_concurrency';
  if (err instanceof TenantTokenBudgetExceededError) return 'quota_budget';
  if (err instanceof BreakerOpenError) return 'breaker_open';
  if (err instanceof ProviderRateLimitError) return 'rate_limit';
  if (err instanceof EmptyProviderResponseError) return 'provider_transient';

  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  if (code === 'TENANT_CONCURRENCY_EXCEEDED') return 'quota_concurrency';
  if (code === 'TENANT_TOKEN_BUDGET_EXCEEDED') return 'quota_budget';
  if (code === 'BREAKER_OPEN') return 'breaker_open';
  if (code === 'PROVIDER_RATE_LIMIT' || code === 'RATE_LIMITED') return 'rate_limit';
  if (code === 'PROVIDER_EMPTY_RESPONSE') return 'provider_transient';

  const errClass = classifyError(err);
  if (errClass === 'rate_limited') return 'rate_limit';
  if (errClass === 'timeout') return 'timeout';
  if (errClass === 'transient') return 'provider_transient';

  return 'unknown';
}

/** Failures that may clear on a short retry (caller re-speaks after hold). */
export function isTransientInfraFailure(kind: ClassifyInfraFailureKind): boolean {
  return (
    kind === 'quota_concurrency' ||
    kind === 'quota_budget' ||
    kind === 'breaker_open' ||
    kind === 'rate_limit' ||
    kind === 'timeout' ||
    kind === 'provider_transient'
  );
}

export function systemFailureReasonForInfra(kind: ClassifyInfraFailureKind): string {
  return `${AI_INFRA_ESCALATE_REASON_PREFIX}${kind}`;
}

export function isAiInfrastructureSystemFailure(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(AI_INFRA_ESCALATE_REASON_PREFIX);
}
