/**
 * D-045 — the owner's own wording for the texts customers get.
 *
 * An owner can replace our wording for four texts (estimate, invoice,
 * customer-portal link, thank-you) with their own, using `{{fill-ins}}`.
 * Their wording is used only when the customer reads the business's own
 * language; anyone else gets our translated text. Whenever their wording
 * can't be used (it can't be read, or a fill-in has no value for this
 * send) the customer gets our text and a warning is logged: a send never
 * fails, and never goes out with a raw `{{fill_in}}`, because of wording.
 */
import type { Pool } from 'pg';

import type { Language } from '../ai/i18n/i18n';
import { PgBaseRepository } from '../db/pg-base';
import {
  extractTemplateVariables,
  renderMessageTemplate,
} from '../messaging/message-template';

export const WORDING_PURPOSES = [
  'estimate_text',
  'invoice_text',
  'portal_link_text',
  'thank_you_text',
] as const;
export type WordingPurpose = (typeof WORDING_PURPOSES)[number];

export function isWordingPurpose(value: string): value is WordingPurpose {
  return (WORDING_PURPOSES as readonly string[]).includes(value);
}

/** The fill-ins each text offers, in the order the settings screen lists them. */
export const WORDING_FILL_INS: Record<WordingPurpose, readonly string[]> = {
  estimate_text: ['customer_name', 'business_name', 'number', 'total', 'link'],
  invoice_text: ['customer_name', 'business_name', 'number', 'total', 'link'],
  portal_link_text: ['customer_name', 'business_name', 'link'],
  thank_you_text: ['customer_name', 'business_name'],
};

/** Texts whose whole point is the link: the owner's wording must carry it. */
const LINK_REQUIRED: ReadonlySet<WordingPurpose> = new Set([
  'estimate_text',
  'invoice_text',
  'portal_link_text',
]);

const FILL_IN = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g;

/** About three text segments: long enough for a friendly note, short enough to read. */
export const MAX_WORDING_LENGTH = 480;

/**
 * What is wrong with a wording, in words the owner can act on; empty when it
 * can be saved.
 */
export function wordingProblems(purpose: WordingPurpose, body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return ['Write the text, or reset to our wording.'];
  const problems: string[] = [];
  if (trimmed.length > MAX_WORDING_LENGTH) {
    problems.push(`Keep it under ${MAX_WORDING_LENGTH} characters (it's ${trimmed.length}).`);
  }
  const allowed = WORDING_FILL_INS[purpose];
  const unknown = extractTemplateVariables(trimmed).filter((v) => !allowed.includes(v));
  if (unknown.length > 0) {
    problems.push(
      `${unknown.map((v) => `{{${v}}}`).join(', ')} can't be filled in here. You can use ${allowed
        .map((v) => `{{${v}}}`)
        .join(', ')}.`,
    );
  }
  // Anything brace-like that isn't a whole `{{fill_in}}` ("{{customer name}}",
  // "{{{link}}}", a missing "}") would reach the customer as typed.
  if (/[{}]/.test(trimmed.replace(FILL_IN, ''))) {
    problems.push('Fill-ins look like {{customer_name}}: two braces each side, no spaces inside. Remove any other { or }.');
  }
  if (LINK_REQUIRED.has(purpose) && !extractTemplateVariables(trimmed).includes('link')) {
    problems.push('Include {{link}} so the customer can open it.');
  }
  return problems;
}

/**
 * The owner's wording with this send's values filled in, the per-send note on
 * the line after the first, and any lines we always add (e.g. "we collect
 * payment in person") at the end. Null when a fill-in it uses has no value.
 */
export function fillOwnerWording(args: {
  body: string;
  values: Partial<Record<string, string>>;
  note?: string;
  extraLines?: readonly string[];
}): string | null {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.values)) {
    // A value's own braces (a customer named "{{link}}") never reach the text.
    if (typeof v === 'string') values[k] = v.replace(/[{}]/g, '').trim();
  }
  const { text, missingVariables } = renderMessageTemplate(args.body.trim(), values);
  // A wording saved before a check existed, or edited outside the screen,
  // must still never send a raw placeholder.
  if (missingVariables.length > 0 || /\{\{|\}\}/.test(text)) return null;
  const lines = text.split('\n');
  const note = args.note?.trim();
  if (note) lines.splice(1, 0, note);
  return [...lines, ...(args.extraLines ?? [])].join('\n');
}

export interface SavedWording {
  purpose: WordingPurpose;
  body: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface CustomerTextWordingRepository {
  list(tenantId: string): Promise<SavedWording[]>;
  find(tenantId: string, purpose: WordingPurpose): Promise<SavedWording | null>;
  save(tenantId: string, purpose: WordingPurpose, body: string, updatedBy: string): Promise<SavedWording>;
  /** True when there was a wording to remove. */
  remove(tenantId: string, purpose: WordingPurpose): Promise<boolean>;
}

export class InMemoryCustomerTextWordingRepository implements CustomerTextWordingRepository {
  private readonly rows = new Map<string, SavedWording>();

  async list(tenantId: string): Promise<SavedWording[]> {
    return WORDING_PURPOSES.flatMap((p) => {
      const row = this.rows.get(`${tenantId}:${p}`);
      return row ? [{ ...row }] : [];
    });
  }

  async find(tenantId: string, purpose: WordingPurpose): Promise<SavedWording | null> {
    const row = this.rows.get(`${tenantId}:${purpose}`);
    return row ? { ...row } : null;
  }

  async save(tenantId: string, purpose: WordingPurpose, body: string, updatedBy: string): Promise<SavedWording> {
    const row: SavedWording = { purpose, body, updatedBy, updatedAt: new Date() };
    this.rows.set(`${tenantId}:${purpose}`, row);
    return { ...row };
  }

  async remove(tenantId: string, purpose: WordingPurpose): Promise<boolean> {
    return this.rows.delete(`${tenantId}:${purpose}`);
  }
}

function rowToWording(row: Record<string, unknown>): SavedWording {
  return {
    purpose: row.purpose as WordingPurpose,
    body: row.body as string,
    updatedBy: row.updated_by as string,
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCustomerTextWordingRepository
  extends PgBaseRepository
  implements CustomerTextWordingRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async list(tenantId: string): Promise<SavedWording[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT purpose, body, updated_by, updated_at FROM customer_text_wording
          WHERE tenant_id = $1 ORDER BY purpose`,
        [tenantId],
      );
      return result.rows.map(rowToWording);
    });
  }

  /**
   * Read inside a savepoint: on a send this runs on the request's own
   * transaction, and a failed read (timeout, table not migrated yet) must
   * leave that transaction usable so the send goes on with our wording.
   */
  async find(tenantId: string, purpose: WordingPurpose): Promise<SavedWording | null> {
    return this.withTenant(tenantId, async (client) => {
      await client.query('SAVEPOINT text_wording_read');
      try {
        const result = await client.query(
          `SELECT purpose, body, updated_by, updated_at FROM customer_text_wording
            WHERE tenant_id = $1 AND purpose = $2`,
          [tenantId, purpose],
        );
        await client.query('RELEASE SAVEPOINT text_wording_read');
        return result.rows[0] ? rowToWording(result.rows[0]) : null;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT text_wording_read');
        await client.query('RELEASE SAVEPOINT text_wording_read').catch(() => undefined);
        throw err;
      }
    });
  }

  async save(tenantId: string, purpose: WordingPurpose, body: string, updatedBy: string): Promise<SavedWording> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customer_text_wording (tenant_id, purpose, body, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id, purpose)
           DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING purpose, body, updated_by, updated_at`,
        [tenantId, purpose, body, updatedBy],
      );
      return rowToWording(result.rows[0]);
    });
  }

  async remove(tenantId: string, purpose: WordingPurpose): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM customer_text_wording WHERE tenant_id = $1 AND purpose = $2`,
        [tenantId, purpose],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

export interface CustomerTextWording {
  /**
   * The text to send: the owner's wording when they wrote one for `purpose`
   * and the customer reads the business's language, else `builtIn()`.
   */
  textFor(args: {
    tenantId: string;
    purpose: WordingPurpose;
    customerLanguage: Language;
    businessLanguage: Language;
    values: Partial<Record<string, string>>;
    note?: string;
    extraLines?: readonly string[];
    builtIn: () => string;
  }): Promise<string>;
}

export function createCustomerTextWording(deps: {
  repo: Pick<CustomerTextWordingRepository, 'find'>;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}): CustomerTextWording {
  return {
    async textFor(args) {
      if (args.customerLanguage !== args.businessLanguage) return args.builtIn();
      let saved: SavedWording | null;
      try {
        saved = await deps.repo.find(args.tenantId, args.purpose);
      } catch (err) {
        deps.logger.warn('Owner text wording could not be read; sending our wording', {
          tenantId: args.tenantId,
          purpose: args.purpose,
          error: err instanceof Error ? err.message : String(err),
        });
        return args.builtIn();
      }
      if (!saved) return args.builtIn();
      let text: string | null;
      try {
        text = fillOwnerWording({
          body: saved.body,
          values: args.values,
          note: args.note,
          extraLines: args.extraLines,
        });
      } catch (err) {
        deps.logger.warn('Owner text wording could not be filled; sending our wording', {
          tenantId: args.tenantId,
          purpose: args.purpose,
          error: err instanceof Error ? err.message : String(err),
        });
        return args.builtIn();
      }
      if (text === null) {
        deps.logger.warn('Owner text wording has a fill-in with no value; sending our wording', {
          tenantId: args.tenantId,
          purpose: args.purpose,
        });
        return args.builtIn();
      }
      return text;
    },
  };
}
