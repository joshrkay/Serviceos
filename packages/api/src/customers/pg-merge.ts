import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { CustomerMergeRepository } from './merge';

/**
 * Story 4.6 — Pg-backed customer merge.
 *
 * Re-parents every child row from the losing customer to the survivor and
 * archives the loser, all inside one tenant-scoped transaction
 * (`withTenantTransaction` sets the RLS GUC and owns BEGIN/COMMIT). Every
 * statement binds `tenant_id = $1` as its first predicate — defense in
 * depth on top of FORCE RLS.
 *
 * Tables whose customer link is a plain `customer_id` are re-parented with
 * a straight UPDATE. Tables with a uniqueness constraint per customer
 * (customer_tags, customer_custom_field_values) move only the rows that
 * won't collide; the survivor's existing rows win and the loser's
 * leftovers are dropped. Contacts are demoted from primary on the way in
 * so the survivor keeps a single primary contact. conversations / notes
 * carry an `(entity_type, entity_id)` reference rather than a FK.
 *
 * Invoices, estimates, appointments and payments are NOT listed here: they
 * key off `job_id`, so re-parenting `jobs` carries them automatically.
 */
export class PgCustomerMergeRepository
  extends PgBaseRepository
  implements CustomerMergeRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async reassignAndArchive(
    tenantId: string,
    survivingId: string,
    losingId: string,
  ): Promise<Record<string, number>> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const counts: Record<string, number> = {};

      // Simple FK re-parents. Order is irrelevant — all scoped to the loser.
      // (service_locations + customer_contacts are handled separately below:
      // they carry a single-primary invariant a blind UPDATE wouldn't respect.)
      //
      // customer_payment_methods is safe as a blind re-parent: its UNIQUE is on
      // (tenant_id, stripe_payment_method_id), which the move never touches —
      // and that same constraint already forbids the two records from sharing a
      // card, so no collision is possible.
      const simpleTables = [
        'jobs',
        'service_agreements',
        'service_credits',
        'customer_payment_methods',
        'voice_sessions',
        'portal_sessions',
      ];
      for (const table of simpleTables) {
        counts[table] = await this.reassign(client, table, tenantId, survivingId, losingId);
      }

      // Service locations + contacts both carry a single-primary invariant —
      // re-parent while preserving exactly one primary on the survivor.
      counts.service_locations = await this.reassignPreservingSinglePrimary(
        client,
        'service_locations',
        tenantId,
        survivingId,
        losingId,
      );
      counts.customer_contacts = await this.reassignPreservingSinglePrimary(
        client,
        'customer_contacts',
        tenantId,
        survivingId,
        losingId,
      );

      // Tags: move only tags the survivor doesn't already carry, then drop
      // the loser's now-duplicate leftovers (the UNIQUE constraint forbids
      // a blind move).
      const tagsMoved = await client.query(
        `UPDATE customer_tags
            SET customer_id = $2
          WHERE tenant_id = $1 AND customer_id = $3
            AND tag NOT IN (
              SELECT tag FROM customer_tags WHERE tenant_id = $1 AND customer_id = $2
            )`,
        [tenantId, survivingId, losingId],
      );
      counts.customer_tags = tagsMoved.rowCount ?? 0;
      await client.query(
        `DELETE FROM customer_tags WHERE tenant_id = $1 AND customer_id = $2`,
        [tenantId, losingId],
      );

      // Custom-field values: the survivor's value wins for any shared field.
      await client.query(
        `DELETE FROM customer_custom_field_values
          WHERE tenant_id = $1 AND customer_id = $2
            AND field_def_id IN (
              SELECT field_def_id FROM customer_custom_field_values
               WHERE tenant_id = $1 AND customer_id = $3
            )`,
        [tenantId, losingId, survivingId],
      );
      const cfvMoved = await client.query(
        `UPDATE customer_custom_field_values
            SET customer_id = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND customer_id = $3`,
        [tenantId, survivingId, losingId],
      );
      counts.customer_custom_field_values = cfvMoved.rowCount ?? 0;

      // B2B hierarchy: sub-accounts of the loser now hang off the survivor.
      // `id <> $2` is defense-in-depth against a self-reference cycle — the
      // mergeCustomers guard already rejects merging a customer into its own
      // descendant, so the survivor can't be in the loser's subtree here.
      const subAccounts = await client.query(
        `UPDATE customers
            SET parent_account_id = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND parent_account_id = $3 AND id <> $2`,
        [tenantId, survivingId, losingId],
      );
      counts.customer_sub_accounts = subAccounts.rowCount ?? 0;

      // Leads converted into the loser now point at the survivor.
      const leads = await client.query(
        `UPDATE leads
            SET converted_customer_id = $2
          WHERE tenant_id = $1 AND converted_customer_id = $3`,
        [tenantId, survivingId, losingId],
      );
      counts.leads = leads.rowCount ?? 0;

      // Entity-reference carriers (no FK): conversations + notes.
      const conversations = await client.query(
        `UPDATE conversations
            SET entity_id = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $3`,
        [tenantId, survivingId, losingId],
      );
      counts.conversations = conversations.rowCount ?? 0;

      const notes = await client.query(
        `UPDATE notes
            SET entity_id = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $3`,
        [tenantId, survivingId, losingId],
      );
      counts.notes = notes.rowCount ?? 0;

      // Finally archive the loser. Non-destructive: the audit event holds
      // the full mapping for reversal.
      await client.query(
        `UPDATE customers
            SET is_archived = true, archived_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, losingId],
      );

      return counts;
    });
  }

  private async reassign(
    client: PoolClient,
    table: string,
    tenantId: string,
    survivingId: string,
    losingId: string,
  ): Promise<number> {
    // `table` is from a fixed in-code allowlist above — never user input —
    // so the identifier interpolation is safe; all values are bound via $N.
    const result = await client.query(
      `UPDATE ${table} SET customer_id = $2 WHERE tenant_id = $1 AND customer_id = $3`,
      [tenantId, survivingId, losingId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Re-parent a table that has a single-active-primary invariant
   * (`is_primary` + `is_archived`, e.g. service_locations, customer_contacts).
   * If the survivor already has an active primary, the incoming rows are
   * demoted so exactly one primary remains; if the survivor has none, the
   * loser's primary (at most one, by the source invariant) is preserved. The
   * `NOT EXISTS` reads the survivor's pre-merge rows (the UPDATE's own changes
   * aren't visible to its subquery), so it can't demote against a row it's
   * about to move. `table` is from the fixed allowlist — never user input.
   */
  private async reassignPreservingSinglePrimary(
    client: PoolClient,
    table: 'service_locations' | 'customer_contacts',
    tenantId: string,
    survivingId: string,
    losingId: string,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE ${table}
          SET customer_id = $2,
              is_primary = is_primary AND NOT EXISTS (
                SELECT 1 FROM ${table}
                 WHERE tenant_id = $1 AND customer_id = $2
                   AND is_primary = true AND is_archived = false
              ),
              updated_at = NOW()
        WHERE tenant_id = $1 AND customer_id = $3`,
      [tenantId, survivingId, losingId],
    );
    return result.rowCount ?? 0;
  }
}
