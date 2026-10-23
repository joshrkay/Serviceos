/**
 * PRIV-4 — `PATCH /api/settings/language` re-pushes the Vapi assistant's first
 * message when `defaultLanguage` changes, because that message carries the
 * virtual-assistant notice in the tenant's default language. The push runs
 * after COMMIT on its own tenant-scoped connection (never inside the request
 * transaction), and a Vapi failure never fails the save.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('PATCH /api/settings/language — Vapi first-message refresh (PRIV-4)', () => {
  const tenantId = crypto.randomUUID();
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let updateAssistant: ReturnType<typeof vi.fn>;
  let defaultLanguage: string;

  function appWith(vapi: boolean): express.Express {
    // tenantQuery checks out a client, scopes it to the tenant and runs the
    // SELECT; every other statement (BEGIN, set_config, COMMIT, RESET) is a no-op.
    const client = {
      query: vi.fn(async (sql: string) =>
        /FROM tenant_settings/.test(sql)
          ? {
              rows: [
                {
                  vapi_assistant_id: 'asst_1',
                  business_name: 'Acme HVAC',
                  voice_greeting: 'Thanks for calling Acme.',
                  services_offered: [],
                  default_language: defaultLanguage,
                },
              ],
            }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'owner-1', sessionId: 's', tenantId, role: 'owner' };
      next();
    });
    app.use(
      '/api/settings',
      createSettingsRouter(
        settingsRepo,
        undefined,
        auditRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        vapi ? { pool: pool as never, vapiClient: { updateAssistant } } : undefined,
      ),
    );
    return app;
  }

  const languageAudits = () =>
    auditRepo.getAll().filter((e) => e.eventType === 'settings.language.updated').map((e) => e.metadata);

  beforeEach(async () => {
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    updateAssistant = vi.fn(async () => undefined);
    defaultLanguage = 'es';
    await createSettings({ tenantId, businessName: 'Acme HVAC' }, settingsRepo);
  });

  it('a switch to Spanish pushes the Spanish notice and records it on the audit', async () => {
    const res = await request(appWith(true)).patch('/api/settings/language').send({ defaultLanguage: 'es' });
    expect(res.status).toBe(200);
    expect(res.body.defaultLanguage).toBe('es');
    await vi.waitFor(() =>
      expect(updateAssistant).toHaveBeenCalledWith('asst_1', {
        firstMessage: 'Thanks for calling Acme. Para que lo sepa, soy un asistente virtual, no una persona real.',
      }),
    );
    expect(languageAudits()).toEqual([{ changedKeys: ['defaultLanguage'] }]);
  });

  it('a Vapi failure still saves the language', async () => {
    updateAssistant.mockRejectedValueOnce(new Error('vapi 503'));
    const res = await request(appWith(true)).patch('/api/settings/language').send({ defaultLanguage: 'es' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(updateAssistant).toHaveBeenCalledTimes(1));
    expect((await settingsRepo.findByTenant(tenantId))?.defaultLanguage).toBe('es');
    expect(languageAudits()).toEqual([{ changedKeys: ['defaultLanguage'] }]);
  });

  it('a change that leaves defaultLanguage alone, or no Vapi client, pushes nothing', async () => {
    await request(appWith(true)).patch('/api/settings/language').send({ supportedLanguages: ['en', 'es'] }).expect(200);
    await request(appWith(false)).patch('/api/settings/language').send({ defaultLanguage: 'es' }).expect(200);
    expect(updateAssistant).not.toHaveBeenCalled();
    expect(languageAudits()).toEqual([{ changedKeys: ['supportedLanguages'] }, { changedKeys: ['defaultLanguage'] }]);
  });
});
