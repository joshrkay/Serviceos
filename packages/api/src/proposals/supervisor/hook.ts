/**
 * Rivet P2 F-1 — the createProposal supervisor hook seam.
 *
 * Injection choice (reported in the track notes): `createProposal` is a
 * SYNCHRONOUS pure builder with 50+ call sites across ai/tasks, workers,
 * routes and schedulers — threading a repo dependency through every call
 * site is not viable, and most of those files are owned by other
 * tracks. So the hook is a MODULE-LEVEL configure: app.ts calls
 * `configureSupervisorCreationHook(service)` once at boot, and
 * `createProposal` consults `getSupervisorCreationHook()` on every
 * invocation. Unconfigured (every test/dev path that doesn't opt in)
 * the hook is null and createProposal behaves byte-identically to
 * before — pinned in test/proposals/supervisor/creation-hook.test.ts.
 *
 * The hook contract is deliberately synchronous: the policy CHECK is
 * pure (policy.ts); the async policy/counter loading lives behind a
 * per-tenant snapshot cache in SupervisorPolicyService, which fails
 * OPEN (permissive) until the snapshot is loaded.
 */
import type { ActionClass, Proposal, ProposalType } from '../proposal';
import type { SupervisorDecision } from './policy';

/**
 * Unit U3 (decision D-004): the supervisor runs BY DEFAULT for every
 * tenant. The platform feature-flag API (`isEnabledForTenant`) is a plain
 * default-FALSE boolean — it has no per-flag default-true or tri-state —
 * so a default-ON gate cannot be expressed with an "enable" flag. We
 * therefore invert to an explicit OPT-OUT flag: when this flag is unset
 * the read returns false ⇒ "not disabled" ⇒ supervisor ON; a tenant turns
 * it OFF by setting the flag to true. The boot wiring (app.ts) reads this
 * flag and passes `enabled = !disabled` into the service/sweep gates,
 * which both already expect "true = enabled". Keep both paths (creation
 * hook + annotator sweep) consistent on this single key.
 */
export const SUPERVISOR_DISABLED_FLAG = 'supervisor_agent_disabled';

export interface SupervisorCreationHookInput {
  tenantId: string;
  proposalType: ProposalType;
  actionClass: ActionClass;
  /** Headline payload money via the shared payloadHeadlineCents, or null. */
  amountCents: number | null;
}

export interface SupervisorCreationHook {
  /**
   * Synchronous policy evaluation against the cached tenant snapshot.
   * Returns null when the supervisor has no opinion (cold cache, tenant
   * flag off, or no snapshot) — the caller proceeds exactly as today.
   */
  evaluate(input: SupervisorCreationHookInput): SupervisorDecision | null;
  /**
   * A proposal was machine-approved at decide time. Implementations
   * must be fire-and-forget internally (never throw, never block).
   */
  onAutoApproved(tenantId: string): void;
  /**
   * A non-'allow' verdict was applied to a freshly built proposal.
   * Implementations emit the audit trail; must be fire-and-forget.
   * NOTE: the proposal is built but not yet persisted at this point —
   * audit rows reference its id, which the caller persists immediately
   * after in every production path.
   */
  onDecision(proposal: Proposal, decision: SupervisorDecision): void;
}

let activeHook: SupervisorCreationHook | null = null;

/**
 * Install (or with null, remove) the process-wide supervisor hook.
 * Called once from app.ts at boot; tests that exercise the hook MUST
 * reset it to null in afterEach so unrelated suites keep the pinned
 * legacy behavior.
 */
export function configureSupervisorCreationHook(hook: SupervisorCreationHook | null): void {
  activeHook = hook;
}

export function getSupervisorCreationHook(): SupervisorCreationHook | null {
  return activeHook;
}
