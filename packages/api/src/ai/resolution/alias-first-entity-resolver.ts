import { Pool } from 'pg';
import { withTenantConnection } from '../../db/tenant-transaction';
import type { EntityAliasRepository } from '../../learning/entity-aliases/entity-alias';
import { normalizeEntityAlias } from '../../learning/entity-aliases/entity-alias';
import {
  type EntityCandidate,
  type EntityKind,
  type EntityResolver,
  type EntityResolverResult,
} from './entity-resolver';

// `lead` is excluded for the same reason `estimate` is: no alias kind is
// minted for it (see learning/entity-aliases/entity-alias.ts's
// `EntityAliasKind`), so a lead reference has no alias row to hit and
// delegates straight through to the trigram resolver. Adding it here without
// an alias kind behind it would be dead configuration (#909). `catalogItem`
// is excluded for the identical reason — `ENTITY_ALIAS_ENTITY_KINDS`
// (@ai-service-os/shared) has no 'catalogItem' member, so there is no
// tenant_entity_aliases row a catalog reference could ever hit.
const ENTITY_LABEL_QUERIES: Record<
  Exclude<EntityKind, 'pending_proposal' | 'estimate' | 'lead' | 'catalogItem'>,
  { table: string; labelColumn: string; extraWhere?: string }
> = {
  customer: {
    table: 'customers',
    labelColumn: 'display_name',
    extraWhere: 'AND is_archived = false',
  },
  job: { table: 'jobs', labelColumn: 'summary' },
  invoice: { table: 'invoices', labelColumn: 'invoice_number' },
  appointment: { table: 'appointments', labelColumn: 'scheduled_start::text' },
  technician: {
    table: 'users',
    labelColumn: "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))",
    extraWhere: "AND role IN ('technician','dispatcher','owner') AND deleted_at IS NULL",
  },
};

/**
 * Decorator that resolves approved tenant aliases before delegating to the
 * existing pg_trgm resolver. Alias hits still verify tenant ownership and
 * target lifecycle before returning a grounded candidate.
 */
export class AliasFirstEntityResolver implements EntityResolver {
  constructor(
    private readonly aliasRepo: EntityAliasRepository,
    private readonly delegate: EntityResolver,
    private readonly pool: Pool,
  ) {}

  async resolve(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
  }): Promise<EntityResolverResult> {
    const aliasResult = await this.resolveViaAlias(input);
    if (aliasResult) return aliasResult;
    return this.delegate.resolve(input);
  }

  private async resolveViaAlias(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
  }): Promise<EntityResolverResult | null> {
    if (
      input.kind === 'pending_proposal' ||
      input.kind === 'estimate' ||
      // #909 — no `lead` alias kind is minted, so there is nothing to look up.
      input.kind === 'lead' ||
      // #909 (live sweeps 9/10) — no `catalogItem` alias kind is minted
      // either, same reason as `lead`/`estimate` above.
      input.kind === 'catalogItem' ||
      !input.reference ||
      input.reference.trim() === ''
    ) {
      return null;
    }

    let normalizedAlias: string;
    try {
      normalizedAlias = normalizeEntityAlias(input.reference);
    } catch {
      return null;
    }

    const alias = await this.aliasRepo.findActiveByAlias({
      tenantId: input.tenantId,
      entityKind: input.kind,
      alias: normalizedAlias,
    });
    if (!alias) return null;

    const candidate = await this.loadGroundedCandidate(
      input.tenantId,
      input.kind,
      alias.entityId,
      alias.sourceAlias,
    );
    if (!candidate) return null;
    return { kind: 'resolved', candidate };
  }

  private async loadGroundedCandidate(
    tenantId: string,
    kind: Exclude<EntityKind, 'pending_proposal' | 'estimate' | 'lead' | 'catalogItem'>,
    entityId: string,
    sourceAlias: string,
  ): Promise<EntityCandidate | null> {
    const querySpec = ENTITY_LABEL_QUERIES[kind];
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{ label: string }>(
          `SELECT ${querySpec.labelColumn} AS label
             FROM ${querySpec.table}
            WHERE tenant_id = $1
              AND id = $2
              ${querySpec.extraWhere ?? ''}
            LIMIT 1`,
          [tenantId, entityId],
        )
        .then((result) => result.rows),
    );
    if (rows.length === 0) return null;
    return {
      id: entityId,
      kind,
      label: rows[0].label ?? sourceAlias,
      score: 1.0,
    };
  }
}
