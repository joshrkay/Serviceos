export type Environment = 'dev' | 'staging' | 'prod';

export interface EnvironmentConfig {
  environment: Environment;
  account?: string;
  region: string;
  vpcCidr: string;
  desiredCount: number;
  cpu: number;
  memoryMiB: number;
  enableDeletionProtection: boolean;
}

export const environments: Record<Environment, EnvironmentConfig> = {
  dev: {
    environment: 'dev',
    region: 'us-east-1',
    vpcCidr: '10.0.0.0/16',
    desiredCount: 1,
    cpu: 256,
    memoryMiB: 512,
    enableDeletionProtection: false,
  },
  staging: {
    environment: 'staging',
    region: 'us-east-1',
    vpcCidr: '10.1.0.0/16',
    desiredCount: 2,
    cpu: 512,
    memoryMiB: 1024,
    enableDeletionProtection: true,
  },
  prod: {
    environment: 'prod',
    region: 'us-east-1',
    vpcCidr: '10.2.0.0/16',
    desiredCount: 3,
    cpu: 1024,
    memoryMiB: 2048,
    enableDeletionProtection: true,
  },
};

export function getEnvironmentConfig(env: Environment): EnvironmentConfig {
  const config = environments[env];
  if (!config) {
    throw new Error(`Unknown environment: ${env}. Valid environments: dev, staging, prod`);
  }
  return config;
}

export function commonTags(env: Environment): Record<string, string> {
  return {
    Project: 'ServiceOS',
    Environment: env,
    ManagedBy: 'CDK',
  };
}
