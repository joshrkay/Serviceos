import * as cdk from 'aws-cdk-lib';
import { PlatformStack } from './stacks/platform-stack';
import { DataStack } from './stacks/data-stack';
import { StorageStack } from './stacks/storage-stack';
import { QueueStack } from './stacks/queue-stack';
import { SecretsStack } from './stacks/secrets-stack';
import { environments, Environment } from './config';

const app = new cdk.App();

const envNames: Environment[] = ['dev', 'staging', 'prod'];

for (const envName of envNames) {
  const envConfig = environments[envName];
  const awsEnv = {
    account: envConfig.account,
    region: envConfig.region,
  };

  // ── 1. Platform: VPC, ECS, ECR, ALB ────────────────────────────────────────
  const platform = new PlatformStack(app, `ServiceOS-Platform-${envName}`, {
    envConfig,
    env: awsEnv,
  });

  // ── 2. Data: RDS Postgres ───────────────────────────────────────────────────
  const data = new DataStack(app, `ServiceOS-Data-${envName}`, {
    envConfig,
    vpc: platform.vpc,
    ecsSecurityGroup: platform.service.connections.securityGroups[0],
    env: awsEnv,
  });
  data.addDependency(platform);

  // ── 3. Storage: S3 uploads bucket ──────────────────────────────────────────
  const storage = new StorageStack(app, `ServiceOS-Storage-${envName}`, {
    envConfig,
    env: awsEnv,
  });

  // ── 4. Queues: SQS transcription queue + DLQ ───────────────────────────────
  const queues = new QueueStack(app, `ServiceOS-Queues-${envName}`, {
    envConfig,
    env: awsEnv,
  });

  // ── 5. Secrets: Clerk + OpenAI keys in Secrets Manager ─────────────────────
  const secrets = new SecretsStack(app, `ServiceOS-Secrets-${envName}`, {
    envConfig,
    env: awsEnv,
  });

  // ── Grant ECS task role access to S3, SQS, and Secrets Manager ─────────────
  const taskRole = platform.service.taskDefinition.taskRole;

  storage.uploadsBucket.grantReadWrite(taskRole);
  queues.transcriptionQueue.grantSendMessages(taskRole);
  queues.transcriptionQueue.grantConsumeMessages(taskRole);
  secrets.clerkSecret.grantRead(taskRole);
  secrets.openAiSecret.grantRead(taskRole);
  secrets.stripeSecret.grantRead(taskRole);
  data.dbSecret.grantRead(taskRole);

  // Suppress unused-variable warnings in strict TS — stacks are registered on app
  void storage;
  void queues;
  void secrets;
  void data;
}

app.synth();
