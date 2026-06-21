/**
 * Stable IDs for UI-flow / mobile capture detail screens.
 * When E2E_USE_TEST_DB seeds journey fixtures, env vars override these.
 */
export const UI_FLOW_FIXTURE = {
  proposalId:
    process.env.E2E_UI_FLOW_PROPOSAL_ID ?? '00000000-0000-0000-0000-000000000001',
  customerId:
    process.env.E2E_TENANT_A_CUSTOMER_ID ??
    process.env.E2E_UI_FLOW_CUSTOMER_ID ??
    '00000000-0000-0000-0000-000000000002',
  threadId:
    process.env.E2E_UI_FLOW_THREAD_ID ?? '00000000-0000-0000-0000-000000000003',
  tenantId:
    process.env.E2E_TENANT_A_ID ?? '00000000-0000-0000-0000-0000000000e2',
};
