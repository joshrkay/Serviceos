import * as cdk from 'aws-cdk-lib';
import { PlatformStack } from './stacks/platform-stack';
import { environments, Environment } from './config';

const app = new cdk.App();

const envNames: Environment[] = ['dev', 'staging', 'prod'];

for (const envName of envNames) {
  const envConfig = environments[envName];
  new PlatformStack(app, `ServiceOS-${envName}`, {
    envConfig,
    env: {
      account: envConfig.account,
      region: envConfig.region,
    },
  });
}

app.synth();
