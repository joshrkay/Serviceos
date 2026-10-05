/**
 * #1561 — behaviour pins for the zod 3 → 4 migration.
 *
 * zod 4 changes default issue messages, `.uuid()` strictness, enum-keyed
 * `z.record` exhaustiveness and error-formatting helpers. Each pin below
 * fixes a client- or gate-visible behaviour at a public seam so the bump
 * cannot silently alter it. Expected values are the zod-3-era outputs
 * clients see today (literals, never recomputed from zod).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createNoteRouter } from '../../src/routes/notes';
import { InMemoryNoteRepository } from '../../src/notes/note';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function notesApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-pins-1561',
      sessionId: 'session-pins-1561',
      tenantId: 'tenant-pins-1561',
      role: 'owner',
    };
    next();
  });
  const ownership: TenantOwnership = {
    async requireExists() {},
    async requireExistsAndLoad() {
      return undefined;
    },
  };
  app.use(
    '/api/notes',
    createNoteRouter(new InMemoryNoteRepository(), ownership, new InMemoryAuditRepository()),
  );
  return app;
}

describe('#1561 pin — API 400 validation error body', () => {
  it('POST /api/notes with a bad body answers the stable VALIDATION_ERROR envelope', async () => {
    const res = await request(notesApp())
      .post('/api/notes')
      .send({ entityType: 'spaceship', content: '', isPinned: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: {
        fields: {
          entityType: [
            "Invalid enum value. Expected 'customer' | 'location' | 'job' | 'estimate' | 'invoice', received 'spaceship'",
          ],
          entityId: ['Required'],
          content: ['String must contain at least 1 character(s)'],
          isPinned: ['Expected boolean, received string'],
        },
      },
    });
  });
});

describe('#1561 pin — proposal missingFields derivation', () => {
  it('a voice draft missing a required field names it in missingFieldPaths and in "<path>: <message>" errors', async () => {
    const { buildVoiceProposalPayload } = await import('../../src/proposals/voice-payload');
    const result = await buildVoiceProposalPayload(
      {
        intent: 'add_material' as never,
        proposalType: 'add_material',
        entities: { vendor: 'Ferguson' },
        envelope: { sessionId: 'sess-pins-1561' },
      },
      { tenantId: 'tenant-pins-1561' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingFieldPaths).toEqual(['description']);
      expect(result.errors).toEqual(['description: Required']);
    }
  });
});

describe('#1561 pin — .default()/.optional() interplay in proposal contracts', () => {
  it('add_material fills quantity=1 and leaves absent optionals absent (not undefined-valued keys)', async () => {
    const { PROPOSAL_TYPE_SCHEMAS } = await import('../../src/proposals/contracts');
    const out = PROPOSAL_TYPE_SCHEMAS.add_material.parse({ description: '  copper elbow  ' });
    expect(out).toStrictEqual({ description: 'copper elbow', quantity: 1 });
  });

  it('emergency_dispatch defaults detectedKeywords to [] and keeps an explicit callerPhone', async () => {
    const { PROPOSAL_TYPE_SCHEMAS } = await import('../../src/proposals/contracts');
    const out = PROPOSAL_TYPE_SCHEMAS.emergency_dispatch.parse({
      emergencyDescription: 'burst pipe',
      callerPhone: '555-0100',
    });
    expect(out).toStrictEqual({
      emergencyDescription: 'burst pipe',
      callerPhone: '555-0100',
      detectedKeywords: [],
    });
  });

  it('an explicit quantity overrides the default; a non-positive one is rejected', async () => {
    const { validateProposalPayload, PROPOSAL_TYPE_SCHEMAS } = await import('../../src/proposals/contracts');
    expect(PROPOSAL_TYPE_SCHEMAS.add_material.parse({ description: 'pipe', quantity: 4 })).toStrictEqual({
      description: 'pipe',
      quantity: 4,
    });
    expect(validateProposalPayload('add_material', { description: 'pipe', quantity: 0 })).toEqual({
      valid: false,
      errors: ['quantity: Number must be greater than 0'],
    });
  });
});

describe('#1561 pin — uuid / email validation on key contracts', () => {
  const FIXTURE_STYLE_ID = '00000000-0000-0000-0000-0000000c0301';
  const LEGACY_REPEATED_ID = '11111111-1111-1111-1111-111111111111';
  const V4_ID = '3f2b8c1e-9a4d-4e6b-8f10-2c7d5e9a1b44';

  it('proposal uuid fields accept any 8-4-4-4-12 hex id Postgres stores (fixture, repeated-digit, v4)', async () => {
    const { validateProposalPayload } = await import('../../src/proposals/contracts');
    for (const jobId of [FIXTURE_STYLE_ID, LEGACY_REPEATED_ID, V4_ID]) {
      expect(validateProposalPayload('add_material', { description: 'pipe', jobId })).toEqual({ valid: true });
    }
  });

  it('proposal uuid fields reject a non-uuid string with the "Invalid uuid" message', async () => {
    const { validateProposalPayload } = await import('../../src/proposals/contracts');
    expect(validateProposalPayload('add_material', { description: 'pipe', jobId: 'job-1' })).toEqual({
      valid: false,
      errors: ['jobId: Invalid uuid'],
    });
  });

  it('the shared uuid/email schemas keep their accept/reject sets', async () => {
    const { uuidSchema, emailSchema } = await import('../../src/shared/validation');
    expect(uuidSchema.safeParse(FIXTURE_STYLE_ID).success).toBe(true);
    expect(uuidSchema.safeParse(LEGACY_REPEATED_ID).success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(emailSchema.safeParse('dana@example.com').success).toBe(true);
    expect(emailSchema.safeParse('dana.o+hvac@sub.example.co').success).toBe(true);
    expect(emailSchema.safeParse('not an email').success).toBe(false);
    expect(emailSchema.safeParse('dana@').success).toBe(false);
  });
});

describe('#1561 pin — validate() helper issue list', () => {
  it('throws ValidationError carrying [{ path, message }] issues with dotted paths', async () => {
    const { validate } = await import('../../src/shared/validation');
    const { z } = await import('zod');
    const schema = z.object({ lines: z.array(z.object({ qty: z.number().int() })) });
    let caught: unknown;
    try {
      validate(schema, { lines: [{ qty: 1.5 }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Validation failed',
      details: { issues: [{ path: 'lines.0.qty', message: 'Expected integer, received float' }] },
    });
  });
});

describe('#1561 pin — triage rules accept a subset of tier keys', () => {
  it('trigger_words naming only TIER_1 loads (enum-keyed record is not exhaustive)', async () => {
    const { loadTriageRules } = await import('../../src/ai/skills/triage-rules.schema');
    const rules = loadTriageRules(
      JSON.stringify({ trigger_words: { TIER_1_EVACUATE: { phrases: ['gas smell'] } } }),
    );
    expect(rules.trigger_words).toEqual({ TIER_1_EVACUATE: { phrases: ['gas smell'] } });
  });

  it('an unknown tier key is still rejected', async () => {
    const { loadTriageRules } = await import('../../src/ai/skills/triage-rules.schema');
    expect(() =>
      loadTriageRules(JSON.stringify({ trigger_words: { TIER_9_PANIC: { phrases: ['x'] } } })),
    ).toThrow();
  });
});

describe('#1561 pin — voice-quality corpus loader', () => {
  it('loads every committed script through VoiceQualityScriptSchema and applies defaults', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { loadCorpus, defaultCorpusRoot } = await import('../../src/ai/voice-quality/corpus/loader');
    const root = defaultCorpusRoot();
    const onDisk = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.json')));
    const scripts = loadCorpus();
    expect(scripts.length).toBe(onDisk.length);
    for (const s of scripts) {
      expect(typeof s.callerIdBlocked).toBe('boolean');
      expect(typeof s.callerIsOwner).toBe('boolean');
      expect(typeof s.layer2Eligible).toBe('boolean');
      for (const t of s.turns) expect(typeof t.hangupAfter).toBe('boolean');
    }
  });
});
