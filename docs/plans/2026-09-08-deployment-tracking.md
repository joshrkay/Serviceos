# Track the deployment created by each release run

GitHub Actions uploads with Railway CLI while Railway GitHub auto-deploys also create entries. The old waiter selected the newest entry, so an unrelated WAITING entry could block verification of a successful CLI release, or an unrelated SUCCESS could mask the target's failure.

## Change

Capture the ID directly from `railway up --detach --json`, fail on upload error or invalid/ambiguous output, and poll only that ID. Pin CLI 5.49.6: its tagged `src/commands/up.rs` returns deploymentId in this mode, and deployment list includes id/status. Source: https://github.com/railwayapp/cli/tree/v5.49.6/src/commands .

Each API/web upload in Development/production has a separate Actions output. Serialize the workflow with cancel-in-progress false; GitHub may replace pending runs with newer pushes, but does not cancel an active release. Preserve dev-before-prod, migration configuration, health checks and smoke tests. Detached upload does not prove build success; the exact-ID waiter catches terminal failure. SKIPPED preserves existing behavior with an explicit message that the new revision was not deployed.

Bound uploads to 300 seconds and each list call to the smaller of 30 seconds and the remaining overall deadline. Do not print raw upload output or errors that may contain sensitive data. Missing target fails closed; listing only the latest 30 entries can time out if the target falls outside the window rather than accepting another release.

## Verification and rollout

Deterministic fake CLI fixtures exercise unrelated waiting/success entries, target failures, missing IDs, command errors, malformed responses, skipped deployments, status transitions and hung CLI calls. No live upload was performed during local testing. Claude Sonnet implemented the core patch and fixtures; Codex completed timeout/output validation and review after the bounded Claude run expired.

Publish and merge the reviewed workflow, then verify its own development release and smoke checks before production. Only after the Actions path is verified should Railway duplicate GitHub auto-deploys be disabled for the product services in both environments. Existing runs use the old workflow and are not repaired retroactively. Do not bypass CI or infer deployment success from a public health URL alone. Settings changes and a live successful release remain pending.
