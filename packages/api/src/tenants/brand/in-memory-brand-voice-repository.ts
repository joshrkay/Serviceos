/**
 * N-011 — in-memory brand-voice repository for no-DB app boot and handler-level
 * tests (mirrors the Pg impl's version-bump semantics).
 */
import type { BrandVoiceSettings } from '../../settings/settings';
import {
  resolveBumpDecision,
  type BrandVoiceRepository,
  type BrandVoiceState,
  type BrandVoiceVersionRow,
  type BrandVoiceMutation,
  type BrandVoiceBumpResult,
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
      mutation: BrandVoiceMutation;
      changedBy: string | null;
      now: number;
    },
  ): Promise<BrandVoiceBumpResult> {
    // Read current → cool-down check + merge → write, with NO interleaving
    // `await`, so under Node's single-threaded model two overlapping
    // bumpVersion calls run to completion one at a time — the in-memory
    // equivalent of the Pg repo's `FOR UPDATE` serialization. This is what
    // makes the concurrency guarantee testable without a database.
    const current: BrandVoiceState = this.state.get(tenantId) ?? {
      config: {},
      version: 0,
      locked: false,
      updatedAt: null,
    };

    const decision = resolveBumpDecision(current, args.mutation, args.now);
    const nextVersion = current.version + 1;
    const updatedAt = new Date(args.now).toISOString();
    const next: BrandVoiceState = {
      config: { ...decision.nextConfig },
      version: nextVersion,
      locked: true,
      updatedAt,
    };
    this.state.set(tenantId, next);
    const rows = this.history.get(tenantId) ?? [];
    rows.push({
      version: nextVersion,
      snapshot: { ...decision.nextConfig },
      changedBy: args.changedBy,
      changeReason: decision.changeReason,
      createdAt: updatedAt,
    });
    this.history.set(tenantId, rows);
    return {
      state: { ...next, config: { ...next.config } },
      fromVersion: decision.fromVersion,
      changedFields: decision.changedFields,
      changeReason: decision.changeReason,
    };
  }
}
