-- Proposal engine: the AI -> human approval -> deterministic execution gate.
-- short_code is the per-tenant integer owners reference in SMS replies
-- ("YES 3"). Statuses mirror @rivet/contracts PROPOSAL_STATUSES.

CREATE TABLE proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('create_customer', 'schedule_job', 'draft_invoice', 'send_invoice')),
  status TEXT NOT NULL DEFAULT 'ready_for_review'
    CHECK (status IN (
      'ready_for_review', 'approved', 'executing', 'executed',
      'execution_failed', 'rejected', 'undone'
    )),
  source TEXT NOT NULL CHECK (source IN ('voice', 'sms', 'web', 'system')),
  short_code INTEGER NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL,
  confidence_bps INTEGER CHECK (confidence_bps BETWEEN 0 AND 10000),
  correlation_id UUID,
  idempotency_key TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  undo_deadline_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, short_code)
);
CREATE UNIQUE INDEX proposals_idempotency_idx ON proposals(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX proposals_tenant_status_idx ON proposals(tenant_id, status, created_at DESC);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON proposals TO rivet_app;
