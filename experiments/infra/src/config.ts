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
  certificateArn?: string;
  /** CORS allowed origins for the S3 uploads bucket */
  corsOrigins: string[];
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
    corsOrigins: ['http://localhost:5173', 'http://localhost:3000', '*'],
  },
  staging: {
    environment: 'staging',
    region: 'us-east-1',
    vpcCidr: '10.1.0.0/16',
    desiredCount: 2,
    cpu: 512,
    memoryMiB: 1024,
    enableDeletionProtection: true,
    // Set to your staging domain before deploying
    corsOrigins: [process.env.STAGING_CORS_ORIGIN || 'https://staging.serviceos.io'],
  },
  prod: {
    environment: 'prod',
    region: 'us-east-1',
    vpcCidr: '10.2.0.0/16',
    desiredCount: 3,
    cpu: 1024,
    memoryMiB: 2048,
    enableDeletionProtection: true,
    // Set to your production domain before deploying
    corsOrigins: [process.env.PROD_CORS_ORIGIN || 'https://app.serviceos.io'],
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
