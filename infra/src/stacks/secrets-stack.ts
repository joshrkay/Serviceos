import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvironmentConfig, commonTags } from '../config';

export interface SecretsStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class SecretsStack extends cdk.Stack {
  public readonly clerkSecret: secretsmanager.Secret;
  public readonly openAiSecret: secretsmanager.Secret;
  public readonly stripeSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const tags = commonTags(envConfig.environment);
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // ── Clerk credentials ─────────────────────────────────────────────────────
    // Placeholder values — update via AWS Console or CLI after deploy.
    // Do NOT put real keys here; this just creates the secret shell.

    this.clerkSecret = new secretsmanager.Secret(this, 'ClerkSecret', {
      secretName: `/serviceos/${envConfig.environment}/clerk`,
      description: 'Clerk API credentials for ServiceOS',
      secretObjectValue: {
        CLERK_SECRET_KEY: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        CLERK_WEBHOOK_SECRET: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      },
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // ── OpenAI key ────────────────────────────────────────────────────────────

    this.openAiSecret = new secretsmanager.Secret(this, 'OpenAiSecret', {
      secretName: `/serviceos/${envConfig.environment}/openai`,
      description: 'OpenAI API key for ServiceOS (Whisper transcription)',
      secretObjectValue: {
        OPENAI_API_KEY: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      },
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // ── Stripe credentials ──────────────────────────────────────────────────

    this.stripeSecret = new secretsmanager.Secret(this, 'StripeSecret', {
      secretName: `/serviceos/${envConfig.environment}/stripe`,
      description: 'Stripe API credentials for ServiceOS payments',
      secretObjectValue: {
        STRIPE_API_KEY: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        STRIPE_WEBHOOK_SECRET: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      },
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ClerkSecretArn', {
      value: this.clerkSecret.secretArn,
      description: 'ARN of the Clerk credentials secret',
      exportName: `ServiceOS-${envConfig.environment}-ClerkSecretArn`,
    });

    new cdk.CfnOutput(this, 'OpenAiSecretArn', {
      value: this.openAiSecret.secretArn,
      description: 'ARN of the OpenAI API key secret',
      exportName: `ServiceOS-${envConfig.environment}-OpenAiSecretArn`,
    });

    new cdk.CfnOutput(this, 'StripeSecretArn', {
      value: this.stripeSecret.secretArn,
      description: 'ARN of the Stripe credentials secret',
      exportName: `ServiceOS-${envConfig.environment}-StripeSecretArn`,
    });

    new cdk.CfnOutput(this, 'SecretsSummary', {
      value: [
        `Clerk: ${this.clerkSecret.secretArn}`,
        `OpenAI: ${this.openAiSecret.secretArn}`,
        `Stripe: ${this.stripeSecret.secretArn}`,
      ].join(' | '),
      description: 'All secret ARNs for this environment',
    });
  }
}
