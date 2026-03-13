# AI Service OS — Architectural Decision Log

> Living document. Update when decisions are made or revised during implementation. Claude Code should reference this when encountering ambiguity.

## How to Use

When implementing a story and facing an architectural choice not covered by the PRD or CLAUDE.md, check this document first. If the answer isn't here, ask the human reviewer. Once decided, add the decision here with date and rationale.

---

## Locked Decisions (from PRD planning)

### D-001: Single-cloud AWS deployment
**Date:** Pre-Phase 0
**Decision:** AWS single-cloud SaaS with CDK in TypeScript
**Rationale:** Team expertise, ECS/Fargate simplicity, integrated services (RDS, S3, SQS, CloudWatch)
**Alternatives rejected:** Multi-cloud, Vercel+Supabase (original PRD baseline), GCP

### D-002: Clerk for auth, not custom
**Date:** Pre-Phase 0
**Decision:** Clerk for authentication with webhook-based tenant bootstrap
**Rationale:** Reduces auth surface area to zero custom code. Webhook model supports tenant creation on first signup without custom flows.
**Alternatives rejected:** Auth0 (more expensive for SMB), NextAuth (too lightweight), custom JWT

### D-003: Integer cents for all money
**Date:** Pre-Phase 0
**Decision:** All monetary values stored as integer cents (bigint in Postgres, number in TypeScript)
**Rationale:** Eliminates floating-point rounding errors in billing calculations. Standard practice for financial software.
**Constraints:** All API inputs/outputs use cents. Frontend handles display formatting (cents → dollars).

### D-004: Proposal-first AI safety model
**Date:** Pre-Phase 0
**Decision:** AI never writes directly to operational entities. All AI output goes through typed proposals that require human approval before deterministic execution.
**Rationale:** Trust is the product's core differentiator in a market where service businesses don't trust software with their money and schedules.
**Constraints:** No auto-execution in beta, even for high-confidence proposals.

### D-005: Provider-agnostic LLM gateway
**Date:** Phase 2 planning
**Decision:** All LLM calls route through a gateway with OpenAI-compatible internal API. Provider adapters handle the translation. Tiered routing by task complexity.
**Rationale:** Avoids vendor lock-in. Enables cost optimization via tiered models (8B for classification, 30B+ for proposals). Enables failover and shadow comparison.
**Constraints:** No module outside the gateway may import provider SDKs.

### D-006: Shared line-item schema for estimates and invoices
**Date:** Phase 1 planning
**Decision:** One line-item model used by both estimates and invoices, distinguished by parent_type.
**Rationale:** Reduces code duplication, ensures consistency when estimates convert to invoices.
**Constraints:** Line-item changes must be validated by both estimate and invoice business rules.

### D-007: Appointment-level assignment as truth
**Date:** Phase 1 planning
**Decision:** Technician assignment is tracked at the appointment level. Job-level assignment is a convenience derived from the most recent appointment.
**Rationale:** A job may have multiple appointments with different technicians. Appointment-level is the operational truth for dispatch.

### D-008: Vertical packs layered on shared core
**Date:** Phase 4 planning
**Decision:** HVAC and plumbing behavior are implemented as activatable packs on top of a shared platform core.
**Rationale:** Prevents vertical-specific logic from contaminating the core. Enables future verticals (painting, electrical) without re-architecture.

### D-009: Stripe payment links, not embedded checkout
**Date:** Phase 5 planning
**Decision:** Payment links generated only after invoice approval. No embedded checkout or card-on-file in beta.
**Rationale:** Minimizes PCI scope. Payment links are sufficient for invoice-based billing in home services.

### D-010: Manual-trigger QuickBooks sync
**Date:** Phase 7 planning
**Decision:** One-way invoice sync to QuickBooks, manually triggered by owner/dispatcher. No auto-sync in first beta.
**Rationale:** Reduces accounting risk. Service businesses need to verify invoices before they hit QuickBooks.

---

## Implementation Decisions (add during build)

### D-011: [Template — copy for new decisions]
**Date:** YYYY-MM-DD
**Decision:** [What was decided]
**Rationale:** [Why this choice over alternatives]
**Story:** [Which story triggered this decision]
**Alternatives rejected:** [What else was considered]
