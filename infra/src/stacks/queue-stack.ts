import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig, commonTags } from '../config';

export interface QueueStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class QueueStack extends cdk.Stack {
  public readonly transcriptionQueue: sqs.Queue;
  public readonly transcriptionDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const tags = commonTags(envConfig.environment);
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // ── Dead-letter queue — receives messages after maxReceiveCount failures ──

    this.transcriptionDlq = new sqs.Queue(this, 'TranscriptionDlq', {
      queueName: `serviceos-transcription-dlq-${envConfig.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // ── Main transcription queue ───────────────────────────────────────────────

    this.transcriptionQueue = new sqs.Queue(this, 'TranscriptionQueue', {
      queueName: `serviceos-transcription-${envConfig.environment}`,
      // visibilityTimeout must be >= Lambda/worker timeout (set to 6× worker timeout)
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.transcriptionDlq,
        maxReceiveCount: 3,
      },
    });

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'TranscriptionQueueUrl', {
      value: this.transcriptionQueue.queueUrl,
      description: 'SQS transcription queue URL',
      exportName: `ServiceOS-${envConfig.environment}-TranscriptionQueueUrl`,
    });

    new cdk.CfnOutput(this, 'TranscriptionQueueArn', {
      value: this.transcriptionQueue.queueArn,
      description: 'SQS transcription queue ARN',
      exportName: `ServiceOS-${envConfig.environment}-TranscriptionQueueArn`,
    });

    new cdk.CfnOutput(this, 'TranscriptionDlqUrl', {
      value: this.transcriptionDlq.queueUrl,
      description: 'SQS transcription dead-letter queue URL',
      exportName: `ServiceOS-${envConfig.environment}-TranscriptionDlqUrl`,
    });
  }
}
