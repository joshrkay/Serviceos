import type { Config } from '../config';
import type { CommandBus } from '../core/commands';
import type { Db } from '../core/db';
import type { JobRunner } from '../core/jobs';
import type { AuthService } from './auth';

export interface AppDeps {
  config: Config;
  db: Db;
  bus: CommandBus;
  jobs: JobRunner;
  auth: AuthService;
}
