# Defect and remediation log — Manual QA 107

| Defect ID | Found in QA ID | Summary | Root cause | Fix commit | Deploy ID | Rerun result | Closed |
|-----------|----------------|---------|------------|------------|-----------|--------------|--------|
| DEF-001 | QA-087 | Bare `/intake` spins forever on "Loading services…" | Missing `?t=` left UI in perpetual loading state; no request fired | pending (this branch) | pending | pending | No |

## Open blockers (infrastructure)

| Blocker | Impacted QA IDs | Attempted resolution | Needs user? |
|---------|-----------------|----------------------|-------------|
| Railway CLI/dashboard auth missing in cloud agent | All DB-backed + deploy-gated IDs | Device login codes issued; no Google/GitHub session; no `RAILWAY_TOKEN` in agent secrets | **Yes** — activate Railway device login or add `RAILWAY_TOKEN` + Development `DATABASE_PUBLIC_URL` |
| Original accounting file path not in workspace | Phase 1 source | Reconstructed 107-item ledger from beta runbook + matrix + WF-50 | Optional — attach original file to reconcile IDs |

## Rules

- No defect is closed until the **original manual workflow** is rerun PASS with evidence.
- “Not testable” remains FAIL until the missing resource is provisioned or the product gap is fixed.
