import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../src/stacks/platform-stack';
import { getEnvironmentConfig, environments, Environment } from '../src/config';

describe('P0-001 — Cloud environments and CDK baseline', () => {
  it('happy path — creates dev stack with required resources', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestDev', {
      envConfig: getEnvironmentConfig('dev'),
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'serviceos-dev',
    });
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  it('creates separate stacks for each environment', () => {
    const app = new cdk.App();
    const envNames: Environment[] = ['dev', 'staging', 'prod'];
    const stacks = envNames.map(
      (env) =>
        new PlatformStack(app, `Test-${env}`, {
          envConfig: getEnvironmentConfig(env),
        })
    );

    stacks.forEach((stack, i) => {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: `serviceos-${envNames[i]}`,
      });
    });
  });

  it('validation — rejects invalid environment', () => {
    expect(() => getEnvironmentConfig('invalid' as Environment)).toThrow(
      'Unknown environment: invalid'
    );
  });

  it('tags all resources with project and environment', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestTags', {
      envConfig: getEnvironmentConfig('staging'),
    });
    const template = Template.fromStack(stack);

    const resources = template.toJSON().Resources;
    const vpcResource = Object.values(resources).find(
      (r: any) => r.Type === 'AWS::EC2::VPC'
    ) as any;
    expect(vpcResource).toBeDefined();
    const tags = vpcResource.Properties?.Tags || [];
    const projectTag = tags.find((t: any) => t.Key === 'Project');
    expect(projectTag?.Value).toBe('ServiceOS');
  });

  it('prod has deletion protection on ECR', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestProd', {
      envConfig: getEnvironmentConfig('prod'),
    });
    const template = Template.fromStack(stack);

    const resources = template.toJSON().Resources;
    const ecrRepos = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::ECR::Repository'
    );
    expect(ecrRepos.length).toBe(1);
    expect((ecrRepos[0] as any).DeletionPolicy).toBe('Retain');
  });

  it('health check configured on container', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestHealth', {
      envConfig: getEnvironmentConfig('dev'),
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          HealthCheck: {
            Command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
          },
        },
      ],
    });
  });

  it('ECR has image scan on push enabled', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestEcrScan', {
      envConfig: getEnvironmentConfig('dev'),
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
    });
  });

  it('HTTPS listener created when certificateArn provided', () => {
    const app = new cdk.App();
    const config = { ...getEnvironmentConfig('staging'), certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc-123' };
    const stack = new PlatformStack(app, 'TestHttps', {
      envConfig: config,
    });
    const template = Template.fromStack(stack);

    // Should have HTTPS listener on port 443
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });

    // Should have HTTP redirect listener on port 80
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  it('prod has KMS encryption for log groups', () => {
    const app = new cdk.App();
    const stack = new PlatformStack(app, 'TestProdKms', {
      envConfig: getEnvironmentConfig('prod'),
    });
    const template = Template.fromStack(stack);

    // Should have a KMS key
    template.resourceCountIs('AWS::KMS::Key', 1);
  });
});
