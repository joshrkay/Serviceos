import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  JobFormField,
  JobFormRepository,
  JobFormSubmission,
  JobFormSubmissionStatus,
  JobFormTemplate,
} from './job-form';

/**
 * J-FORM (Jobber parity) — Postgres-backed job forms & checklists.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 221). Template `fields` and submission
 * `fields`/`answers` are stored as JSONB; submissions snapshot the template
 * name + fields so completed records are immutable history.
 */

function mapTemplate(row: Record<string, unknown>): JobFormTemplate {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    fields: Array.isArray(row.fields) ? (row.fields as JobFormField[]) : [],
    sortOrder: row.sort_order as number,
    isArchived: row.is_archived as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSubmission(row: Record<string, unknown>): JobFormSubmission {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    templateId: row.template_id as string,
    templateName: row.template_name as string,
    fields: Array.isArray(row.fields) ? (row.fields as JobFormField[]) : [],
    answers: Array.isArray(row.answers)
      ? (row.answers as JobFormSubmission['answers'])
      : [],
    status: row.status as JobFormSubmissionStatus,
    completedBy: (row.completed_by as string | null) ?? null,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobFormRepository extends PgBaseRepository implements JobFormRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createTemplate(template: JobFormTemplate): Promise<JobFormTemplate> {
    return this.withTenant(template.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_form_templates (
          id, tenant_id, name, description, fields, sort_order,
          is_archived, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        RETURNING *`,
        [
          template.id,
          template.tenantId,
          template.name,
          template.description,
          JSON.stringify(template.fields),
          template.sortOrder,
          template.isArchived,
          template.createdAt,
          template.updatedAt,
        ]
      );
      return mapTemplate(result.rows[0]);
    });
  }

  async findTemplateById(tenantId: string, id: string): Promise<JobFormTemplate | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM job_form_templates WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapTemplate(result.rows[0]) : null;
    });
  }

  async listTemplates(tenantId: string, includeArchived = false): Promise<JobFormTemplate[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      if (!includeArchived) conditions.push('is_archived = false');
      const result = await client.query(
        `SELECT * FROM job_form_templates
         WHERE ${conditions.join(' AND ')}
         ORDER BY sort_order ASC, name ASC`,
        [tenantId]
      );
      return result.rows.map(mapTemplate);
    });
  }

  async updateTemplate(template: JobFormTemplate): Promise<JobFormTemplate> {
    return this.withTenant(template.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_form_templates
         SET name = $3, description = $4, fields = $5::jsonb, sort_order = $6,
             is_archived = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          template.tenantId,
          template.id,
          template.name,
          template.description,
          JSON.stringify(template.fields),
          template.sortOrder,
          template.isArchived,
          template.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error('Job form template not found');
      return mapTemplate(result.rows[0]);
    });
  }

  async archiveTemplate(tenantId: string, id: string): Promise<JobFormTemplate | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_form_templates
         SET is_archived = true, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapTemplate(result.rows[0]) : null;
    });
  }

  async createSubmission(submission: JobFormSubmission): Promise<JobFormSubmission> {
    return this.withTenant(submission.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_form_submissions (
          id, tenant_id, job_id, template_id, template_name, fields, answers,
          status, completed_by, completed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          submission.id,
          submission.tenantId,
          submission.jobId,
          submission.templateId,
          submission.templateName,
          JSON.stringify(submission.fields),
          JSON.stringify(submission.answers),
          submission.status,
          submission.completedBy,
          submission.completedAt,
          submission.createdAt,
          submission.updatedAt,
        ]
      );
      return mapSubmission(result.rows[0]);
    });
  }

  async findSubmissionById(tenantId: string, id: string): Promise<JobFormSubmission | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM job_form_submissions WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapSubmission(result.rows[0]) : null;
    });
  }

  async listSubmissionsByJob(tenantId: string, jobId: string): Promise<JobFormSubmission[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_form_submissions
         WHERE tenant_id = $1 AND job_id = $2
         ORDER BY created_at ASC`,
        [tenantId, jobId]
      );
      return result.rows.map(mapSubmission);
    });
  }

  async updateSubmission(submission: JobFormSubmission): Promise<JobFormSubmission> {
    return this.withTenant(submission.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_form_submissions
         SET answers = $3::jsonb, status = $4, completed_by = $5,
             completed_at = $6, updated_at = $7
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          submission.tenantId,
          submission.id,
          JSON.stringify(submission.answers),
          submission.status,
          submission.completedBy,
          submission.completedAt,
          submission.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error('Job form submission not found');
      return mapSubmission(result.rows[0]);
    });
  }
}
