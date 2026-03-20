import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { InternalNote, NoteEntityType, NoteRepository } from './note';

function mapRow(row: Record<string, unknown>): InternalNote {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    entityType: row.entity_type as NoteEntityType,
    entityId: row.entity_id as string,
    content: row.content as string,
    authorId: row.author_id as string,
    authorRole: row.author_role as string,
    isPinned: row.is_pinned as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgNoteRepository extends PgBaseRepository implements NoteRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(note: InternalNote): Promise<InternalNote> {
    return this.withTenant(note.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO notes (id, tenant_id, entity_type, entity_id, content, author_id, author_role, is_pinned, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          note.id,
          note.tenantId,
          note.entityType,
          note.entityId,
          note.content,
          note.authorId,
          note.authorRole,
          note.isPinned,
          note.createdAt,
          note.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<InternalNote | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM notes WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByEntity(tenantId: string, entityType: NoteEntityType, entityId: string): Promise<InternalNote[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM notes WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC`,
        [tenantId, entityType, entityId]
      );
      return result.rows.map(mapRow);
    });
  }

  async update(tenantId: string, id: string, updates: Partial<InternalNote>): Promise<InternalNote | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.content !== undefined) {
        setClauses.push(`content = $${paramIndex++}`);
        values.push(updates.content);
      }
      if (updates.isPinned !== undefined) {
        setClauses.push(`is_pinned = $${paramIndex++}`);
        values.push(updates.isPinned);
      }
      if (updates.updatedAt !== undefined) {
        setClauses.push(`updated_at = $${paramIndex++}`);
        values.push(updates.updatedAt);
      } else {
        setClauses.push(`updated_at = $${paramIndex++}`);
        values.push(new Date());
      }

      if (setClauses.length === 0) {
        return this.findById(tenantId, id);
      }

      values.push(id);
      values.push(tenantId);

      const result = await client.query(
        `UPDATE notes SET ${setClauses.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM notes WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
