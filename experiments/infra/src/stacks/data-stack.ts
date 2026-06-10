import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvironmentConfig, commonTags } from '../config';

export interface DataStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envConfig, vpc, ecsSecurityGroup } = props;
    const tags = commonTags(envConfig.environment);
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // ── Security group for RDS — only accepts traffic from ECS tasks ──────────

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Allow Postgres access from ECS tasks only',
      allowAllOutbound: false,
    });

    this.dbSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Postgres from ECS service'
    );

    // ── Subnet group — place RDS in isolated (no-egress) subnets ─────────────

    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      vpc,
      description: `ServiceOS RDS subnet group (${envConfig.environment})`,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // ── DB credentials — stored in Secrets Manager automatically ─────────────

    const dbInstanceSizes: Record<string, ec2.InstanceType> = {
      dev: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      staging: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      prod: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
    };

    this.dbInstance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: dbInstanceSizes[envConfig.environment],
      vpc,
      subnetGroup,
      securityGroups: [this.dbSecurityGroup],
      databaseName: `serviceos_${envConfig.environment}`,
      credentials: rds.Credentials.fromGeneratedSecret('serviceos', {
        secretName: `/serviceos/${envConfig.environment}/db-credentials`,
      }),
      multiAz: envConfig.environment === 'prod',
      allocatedStorage: envConfig.environment === 'prod' ? 100 : 20,
      maxAllocatedStorage: envConfig.environment === 'prod' ? 500 : 100,
      storageEncrypted: true,
      deletionProtection: envConfig.enableDeletionProtection,
      backupRetention: cdk.Duration.days(envConfig.environment === 'prod' ? 30 : 7),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'Mon:04:00-Mon:05:00',
      enablePerformanceInsights: envConfig.environment === 'prod',
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    });

    this.dbSecret = this.dbInstance.secret!;

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: this.dbInstance.dbInstanceEndpointAddress,
      description: 'RDS Postgres endpoint',
      exportName: `ServiceOS-${envConfig.environment}-DbEndpoint`,
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      description: 'ARN of the DB credentials secret in Secrets Manager',
      exportName: `ServiceOS-${envConfig.environment}-DbSecretArn`,
    });
  }
}
