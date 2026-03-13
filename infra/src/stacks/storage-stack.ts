import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvironmentConfig, commonTags } from '../config';

export interface StorageStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class StorageStack extends cdk.Stack {
  public readonly uploadsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const tags = commonTags(envConfig.environment);
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      bucketName: `serviceos-uploads-${envConfig.environment}`,
      versioned: envConfig.environment === 'prod',
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !envConfig.enableDeletionProtection,

      // CORS — allows the React frontend to upload directly via presigned URLs
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins:
            envConfig.environment === 'prod'
              ? ['https://app.serviceos.io']
              : ['http://localhost:5173', 'http://localhost:3000', '*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],

      // Lifecycle — expire temp/failed uploads, transition old objects to cheaper storage
      lifecycleRules: [
        {
          id: 'expire-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        ...(envConfig.environment === 'prod'
          ? [
              {
                id: 'transition-to-ia',
                transitions: [
                  {
                    storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                    transitionAfter: cdk.Duration.days(90),
                  },
                  {
                    storageClass: s3.StorageClass.GLACIER,
                    transitionAfter: cdk.Duration.days(365),
                  },
                ],
              },
            ]
          : []),
      ],
    });

    new cdk.CfnOutput(this, 'UploadsBucketName', {
      value: this.uploadsBucket.bucketName,
      description: 'S3 uploads bucket name',
      exportName: `ServiceOS-${envConfig.environment}-UploadsBucket`,
    });

    new cdk.CfnOutput(this, 'UploadsBucketArn', {
      value: this.uploadsBucket.bucketArn,
      description: 'S3 uploads bucket ARN',
      exportName: `ServiceOS-${envConfig.environment}-UploadsBucketArn`,
    });
  }
}
