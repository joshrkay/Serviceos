export interface ProviderMetrics {
  latencies: number[]; // recent latencies in ms
  errors: number;
  successes: number;
  windowStartMs: number;
}

export interface HealthThresholds {
  maxErrorRate: number; // 0-1, default 0.1 (10%)
  maxP95LatencyMs: number; // default 30000 (30s)
  windowMs: number; // default 300000 (5 min)
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxErrorRate: 0.1,
  maxP95LatencyMs: 30000,
  windowMs: 300000,
};

export function calculatePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

interface TimestampedResult {
  latencyMs: number;
  success: boolean;
  timestampMs: number;
}

export class ProviderHealthMonitor {
  private readonly thresholds: HealthThresholds;
  private readonly results: Map<string, TimestampedResult[]> = new Map();

  constructor(thresholds?: Partial<HealthThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  recordResult(provider: string, latencyMs: number, success: boolean): void {
    if (!this.results.has(provider)) {
      this.results.set(provider, []);
    }

    const entries = this.results.get(provider)!;
    entries.push({ latencyMs, success, timestampMs: Date.now() });

    this.pruneOldEntries(provider);
  }

  isHealthy(provider: string): boolean {
    this.pruneOldEntries(provider);

    const entries = this.results.get(provider);
    if (!entries || entries.length === 0) {
      return true; // No data means assume healthy
    }

    const total = entries.length;
    const errors = entries.filter((e) => !e.success).length;
    const errorRate = errors / total;

    if (errorRate > this.thresholds.maxErrorRate) {
      return false;
    }

    const sortedLatencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
    const p95 = calculatePercentile(sortedLatencies, 95);

    if (p95 > this.thresholds.maxP95LatencyMs) {
      return false;
    }

    return true;
  }

  getMetrics(provider: string): { errorRate: number; p95LatencyMs: number; p50LatencyMs: number; sampleCount: number } | null {
    this.pruneOldEntries(provider);

    const entries = this.results.get(provider);
    if (!entries || entries.length === 0) {
      return null;
    }

    const total = entries.length;
    const errors = entries.filter((e) => !e.success).length;
    const sortedLatencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);

    return {
      errorRate: errors / total,
      p95LatencyMs: calculatePercentile(sortedLatencies, 95),
      p50LatencyMs: calculatePercentile(sortedLatencies, 50),
      sampleCount: total,
    };
  }

  reset(provider: string): void {
    this.results.delete(provider);
  }

  private pruneOldEntries(provider: string): void {
    const entries = this.results.get(provider);
    if (!entries) return;

    const cutoff = Date.now() - this.thresholds.windowMs;
    const pruned = entries.filter((e) => e.timestampMs >= cutoff);
    this.results.set(provider, pruned);
  }
}
