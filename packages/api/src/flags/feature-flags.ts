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
