/**
 * Type-level test: ProposalExecutor requires an IdempotencyGuard and an
 * AuditRepository. This file is checked by tsc; failures show up as compile
 * errors.
 *
 * Enforces §11 H1: every executor wiring must thread an IdempotencyGuard
 * so message redelivery cannot double-execute side effects.
 * Enforces WS11: every executor wiring must thread an AuditRepository so an
 * execution outcome cannot commit without its audit event.
 */
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { ProposalRepository, ProposalType } from '../../../src/proposals/proposal';
import { ExecutionHandler } from '../../../src/proposals/execution/handlers';
import { AuditRepository } from '../../../src/audit/audit';

declare const handlers: Map<ProposalType, ExecutionHandler>;
declare const proposalRepo: ProposalRepository;
declare const guard: IdempotencyGuard;
declare const auditRepo: AuditRepository;

// This must compile.
const ok: ProposalExecutor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
void ok;

// This must NOT compile — omitting the guard.
// @ts-expect-error idempotency guard is required (§11 H1)
new ProposalExecutor(handlers, proposalRepo);

// This must NOT compile — omitting the audit repository (WS11).
// @ts-expect-error audit repository is required (WS11)
new ProposalExecutor(handlers, proposalRepo, guard);
