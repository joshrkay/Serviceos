/**
 * Type-level test: ProposalExecutor requires an IdempotencyGuard.
 * This file is checked by tsc; failures show up as compile errors.
 *
 * Enforces §11 H1: every executor wiring must thread an IdempotencyGuard
 * so message redelivery cannot double-execute side effects.
 */
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { ProposalRepository, ProposalType } from '../../../src/proposals/proposal';
import { ExecutionHandler } from '../../../src/proposals/execution/handlers';

declare const handlers: Map<ProposalType, ExecutionHandler>;
declare const proposalRepo: ProposalRepository;
declare const guard: IdempotencyGuard;

// This must compile.
const ok: ProposalExecutor = new ProposalExecutor(handlers, proposalRepo, guard);
void ok;

// This must NOT compile — omitting the guard.
// @ts-expect-error idempotency guard is required (§11 H1)
new ProposalExecutor(handlers, proposalRepo);
