export interface FeatureFlag {
  name: string;
  enabled: boolean;
  environments?: string[];
  tenantIds?: string[];
  description?: string;
}

export interface FeatureFlagStore {
  getFlags(): FeatureFlag[];
  getFlag(name: string): FeatureFlag | undefined;
  setFlag(flag: FeatureFlag): void;
  removeFlag(name: string): void;
}

export class InMemoryFeatureFlagStore implements FeatureFlagStore {
  private flags: Map<string, FeatureFlag> = new Map();

  constructor(initialFlags?: FeatureFlag[]) {
    if (initialFlags) {
      initialFlags.forEach((f) => this.flags.set(f.name, f));
    }
  }

  getFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  getFlag(name: string): FeatureFlag | undefined {
    return this.flags.get(name);
  }

  setFlag(flag: FeatureFlag): void {
    if (!flag.name || flag.name.trim().length === 0) {
      throw new Error('Flag name is required');
    }
    this.flags.set(flag.name, flag);
  }

  removeFlag(name: string): void {
    this.flags.delete(name);
  }
}

export function isFeatureEnabled(
  store: FeatureFlagStore,
  flagName: string,
  context: { environment: string; tenantId?: string }
): boolean {
  const flag = store.getFlag(flagName);
  if (!flag) return false;
  if (!flag.enabled) return false;

  if (flag.environments && flag.environments.length > 0) {
    if (!flag.environments.includes(context.environment)) return false;
  }

  if (flag.tenantIds && flag.tenantIds.length > 0) {
    if (!context.tenantId || !flag.tenantIds.includes(context.tenantId)) return false;
  }

  return true;
}

/**
 * P7-015 — async persistence layer for feature flags.
 *
 * FeatureFlagStore stays synchronous (hot path — checked on every request
 * that gates on a flag). Persistence is async: a FeatureFlagRepository
 * provides durability, and a bootstrap call hydrates the sync store on
 * startup. Admin APIs go through the repository so writes survive restarts.
 */
export interface FeatureFlagRepository {
  list(): Promise<FeatureFlag[]>;
  get(name: string): Promise<FeatureFlag | null>;
  upsert(flag: FeatureFlag): Promise<FeatureFlag>;
  delete(name: string): Promise<boolean>;
}

export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  private flags: Map<string, FeatureFlag> = new Map();

  async list(): Promise<FeatureFlag[]> {
    return Array.from(this.flags.values()).map((f) => ({ ...f }));
  }

  async get(name: string): Promise<FeatureFlag | null> {
    const f = this.flags.get(name);
    return f ? { ...f } : null;
  }

  async upsert(flag: FeatureFlag): Promise<FeatureFlag> {
    if (!flag.name || flag.name.trim().length === 0) {
      throw new Error('Flag name is required');
    }
    const stored = { ...flag };
    this.flags.set(flag.name, stored);
    return { ...stored };
  }

  async delete(name: string): Promise<boolean> {
    return this.flags.delete(name);
  }
}

export async function hydrateStoreFromRepository(
  store: FeatureFlagStore,
  repo: FeatureFlagRepository
): Promise<void> {
  const flags = await repo.list();
  for (const flag of flags) {
    store.setFlag(flag);
  }
}
