# infra/ — AWS CDK stacks (NOT the deployment target)

> **Status: not deployed. ServiceOS runs on Railway, not AWS.**
> Do not run `cdk deploy` expecting to update production.

This directory contains a complete, well-formed set of AWS CDK stacks
(Fargate + RDS Postgres + S3 + SQS + Secrets Manager + ACM/KMS). It was
built as a possible future deployment target, but **nothing deploys it**:

- No GitHub workflow or script runs `cdk synth` / `cdk deploy`
  (CI only builds, tests, and deploys to Railway — see `.github/workflows/`).
- The ECS task definition pulls image tag `latest` from an ECR repository
  that **no CI pipeline ever pushes to**, so even a manual `cdk deploy`
  would not run current application code.
- `infra/src/config.ts` leaves `account` unset and falls back to public
  placeholder domains, so it would not deploy cleanly as-is.

## What actually runs production

The canonical deployment is **Railway**, defined by:

- `/railway.toml` — build (Dockerfile target `api`), `preDeployCommand`
  (runs migrations), `startCommand`, health check.
- `/Dockerfile` — multi-stage build for `packages/api` (and the `web`
  nginx stage).
- `.github/workflows/deploy.yml` — runs `railway up` for the api and web
  services on push to `main`.

See [`/docs/deployment.md`](../docs/deployment.md).

## If you intend to revive the AWS path

Before treating this as real, you would need to: wire `cdk synth` into CI
to prevent drift, set up an ECR push in the image build, populate real
`account`/`domain` config, and reconcile the schema/migration strategy with
the in-code migrations (`packages/api/src/db/schema.ts`). Until then, treat
everything here as a reference design, not infrastructure-as-truth.
