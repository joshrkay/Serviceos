/**
 * N-011 — in-memory brand-voice repository for no-DB app boot and handler-level
 * tests (mirrors the Pg impl's version-bump semantics).
 */
import type { BrandVoiceSettings } from '../../settings/settings';
import type {
  BrandVoiceRepository,
  BrandVoiceState,
  BrandVoiceVersionRow,
  BrandVoiceChangeReason,
} from './brand-voice';

export class InMemoryBrandVoiceRepository implements BrandVoiceRepository {
  private state = new Map<string, BrandVoiceState>();
  private history = new Map<string, BrandVoiceVersionRow[]>();

  async getState(tenantId: string): Promise<BrandVoiceState> {
    const s = this.state.get(tenantId);
    if (!s) return { config: {}, version: 0, locked: false, updatedAt: null };
    return { ...s, config: { ...s.config } };
  }

  async listVersions(tenantId: string): Promise<BrandVoiceVersionRow[]> {
    return [...(this.history.get(tenantId) ?? [])].sort(
      (a, b) => b.version - a.version,
    );
  }

  async getVersionSnapshot(
    tenantId: string,
    version: number,
  ): Promise<BrandVoiceSettings | null> {
    const row = (this.history.get(tenantId) ?? []).find(
      (r) => r.version === version,
    );
    return row ? { ...row.snapshot } : null;
  }

  async bumpVersion(
    tenantId: string,
    args: {
      config: BrandVoiceSettings;
      changedBy: string | null;
      changeReason: BrandVoiceChangeReason;
      updatedAt: string;
    },
  ): Promise<BrandVoiceState> {
    const current = this.state.get(tenantId);
    const nextVersion = (current?.version ?? 0) + 1;
    const updatedAt = args.updatedAt;
    const next: BrandVoiceState = {
      config: { ...args.config },
      version: nextVersion,
      locked: true,
      updatedAt,
    };
    this.state.set(tenantId, next);
    const rows = this.history.get(tenantId) ?? [];
    rows.push({
      version: nextVersion,
      snapshot: { ...args.config },
      changedBy: args.changedBy,
      changeReason: args.changeReason,
      createdAt: updatedAt,
    });
    this.history.set(tenantId, rows);
    return { ...next, config: { ...next.config } };
  }
}
