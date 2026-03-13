import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { EnvironmentConfig, commonTags } from '../config';

const CONTAINER_PORT = 3000;

export interface PlatformStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class PlatformStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.Repository;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const tags = commonTags(envConfig.environment);
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(envConfig.vpcCidr),
      maxAzs: 2,
      natGateways: envConfig.environment === 'prod' ? 2 : 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      clusterName: `serviceos-${envConfig.environment}`,
      containerInsights: envConfig.environment === 'prod',
    });

    this.repository = new ecr.Repository(this, 'ApiRepo', {
      repositoryName: `serviceos-api-${envConfig.environment}`,
      imageScanOnPush: true,
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        { maxImageCount: 10, description: 'Keep last 10 images' },
      ],
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: envConfig.cpu,
      memoryLimitMiB: envConfig.memoryMiB,
    });

    const logGroupProps: logs.LogGroupProps = {
      logGroupName: `/serviceos/${envConfig.environment}/api`,
      retention: envConfig.environment === 'prod'
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: envConfig.enableDeletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    };

    if (envConfig.environment === 'prod') {
      const logEncryptionKey = new kms.Key(this, 'LogEncryptionKey', {
        description: 'KMS key for encrypting ServiceOS API log groups',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      (logGroupProps as any).encryptionKey = logEncryptionKey;
    }

    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', logGroupProps);

    taskDefinition.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      environment: {
        NODE_ENV: envConfig.environment,
        PORT: String(CONTAINER_PORT),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${CONTAINER_PORT}/health || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: true,
      loadBalancerName: `serviceos-${envConfig.environment}`,
    });

    if (envConfig.certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this, 'Certificate', envConfig.certificateArn
      );

      const httpsListener = this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
      });

      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      this.service = new ecs.FargateService(this, 'ApiService', {
        cluster: this.cluster,
        taskDefinition,
        desiredCount: envConfig.desiredCount,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });

      httpsListener.addTargets('ApiTarget', {
        port: CONTAINER_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.service],
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
    } else {
      const listener = this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });

      this.service = new ecs.FargateService(this, 'ApiService', {
        cluster: this.cluster,
        taskDefinition,
        desiredCount: envConfig.desiredCount,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });

      listener.addTargets('ApiTarget', {
        port: CONTAINER_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.service],
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
    }

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
    });
  }
}
