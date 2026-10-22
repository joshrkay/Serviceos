import { z } from 'zod';

/**
 * Dispatch FR-2 phase 2 — skill tags. Technicians hold `users.skills`; a job
 * lists `jobs.required_skills`; the API's feasibility skill gate
 * (packages/api/src/scheduling/skill-matcher.ts) compares the two in this
 * canonical form. The web editor normalizes with the same function so what
 * the owner sees is what gets stored.
 */
export const MAX_SKILL_TAGS = 20;
export const MAX_SKILL_TAG_LENGTH = 40;
const SKILL_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * One tag in canonical form: trimmed, lower-cased, inner whitespace runs
 * folded to `_` ("EPA 608" → "epa_608"). Null when nothing is left or the tag
 * holds characters outside [a-z0-9_-]. Matching is exact on this form, so a
 * job's "Gas Certified" and a tech's "gas_certified" are the same skill.
 */
export function normalizeSkillTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (tag.length === 0 || tag.length > MAX_SKILL_TAG_LENGTH) return null;
  return SKILL_TAG_PATTERN.test(tag) ? tag : null;
}

/** Canonical, de-duplicated tags in first-seen order. Unusable entries are dropped. */
export function normalizeSkillTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const tag = normalizeSkillTag(r);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Request-boundary schema for a skill list (PATCH /api/users/:id `skills`,
 * PUT /api/jobs/:id `requiredSkills`). A tag that cannot be normalized is a
 * 400 rather than a silent drop, so the owner learns their tag was not saved.
 */
export const skillTagsSchema = z
  .array(z.string().max(MAX_SKILL_TAG_LENGTH * 2))
  .max(MAX_SKILL_TAGS, `At most ${MAX_SKILL_TAGS} skills`)
  .superRefine((tags, ctx) => {
    for (const t of tags) {
      if (normalizeSkillTag(t) === null) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid skill "${t}": use letters, numbers, spaces, - or _ (max ${MAX_SKILL_TAG_LENGTH} characters)`,
        });
      }
    }
  })
  .transform((tags) => normalizeSkillTags(tags));
