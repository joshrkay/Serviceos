/**
 * B1 — the backup supervisor must be someone who can approve work.
 *
 * Their mobile is an approval phone (SMS Y / N / EDIT, the voice owner line,
 * one-tap links when the tenant has no owner phone), and every one of those
 * now approves with the backup's real role. A technician holds no
 * proposals:approve, so naming one the backup would hand out an approval
 * phone that can never approve anything. PUT /api/settings refuses it with a
 * plain 400 (owner-facing copy) and accepts a dispatcher.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemorySettingsRepository, createSettings, getSettings } from '../../src/settings/settings';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = 'tenant-backup-role';

describe('PUT /api/settings — backupSupervisorUserId must be able to approve (B1)', () => {
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;
  let users: InMemoryUserRepository;
  let audit: InMemoryAuditRepository;

  async function member(role: 'owner' | 'dispatcher' | 'technician'): Promise<string> {
    const user = await users.create!({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      email: `${role}-${Math.random().toString(36).slice(2)}@example.com`,
      role,
      canFieldServe: role !== 'dispatcher',
      mobileNumber: '+15125550111',
    });
    return user.id;
  }

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-owner',
        sessionId: 'session-1',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    settingsRepo = new InMemorySettingsRepository();
    users = new InMemoryUserRepository();
    audit = new InMemoryAuditRepository();
    await createSettings({ tenantId: TENANT, businessName: 'Backup Co' }, settingsRepo);
    app.use(
      '/api/settings',
      createSettingsRouter(settingsRepo, undefined, audit, undefined, undefined, { userRepo: users }),
    );
  });

  it('refuses a technician with a plain 400 and stores nothing', async () => {
    const technician = await member('technician');

    const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: technician });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe("That team member can't approve work, so they can't be your backup.");
    expect(res.body.details.field).toBe('backupSupervisorUserId');
    expect((await getSettings(TENANT, settingsRepo))?.backupSupervisorUserId ?? null).toBeNull();
  });

  it.each(['dispatcher', 'owner'] as const)('accepts a %s', async (role) => {
    const id = await member(role);

    const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: id });

    expect(res.status).toBe(200);
    expect(res.body.backupSupervisorUserId).toBe(id);
  });

  // B1 follow-up — a tenant whose backup was a technician before B1 got the
  // 400 on EVERY save of the section (it re-sends the stored backup with the
  // routing). The rule is about who is being made the backup: an unchanged
  // legacy value is accepted (it carries no approval authority after B1).
  describe('a legacy technician backup already on file', () => {
    let legacy: string;
    beforeEach(async () => {
      legacy = await member('technician');
      await settingsRepo.update(TENANT, { backupSupervisorUserId: legacy });
    });

    it('re-sending the unchanged backup with a routing change saves', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ backupSupervisorUserId: legacy, unsupervisedProposalRouting: 'queue_only' });

      expect(res.status).toBe(200);
      expect(res.body.backupSupervisorUserId).toBe(legacy);
      expect((await getSettings(TENANT, settingsRepo))?.unsupervisedProposalRouting).toBe('queue_only');
    });

    it('changing to another technician is still refused', async () => {
      const other = await member('technician');

      const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: other });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("That team member can't approve work, so they can't be your backup.");
      expect((await getSettings(TENANT, settingsRepo))?.backupSupervisorUserId).toBe(legacy);
    });

    it('changing to a dispatcher saves', async () => {
      const dispatcher = await member('dispatcher');

      const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: dispatcher });

      expect(res.status).toBe(200);
      expect(res.body.backupSupervisorUserId).toBe(dispatcher);
    });
  });

  // B3-3 — the #1463 active-member check still ran on an UNCHANGED value, so
  // an API client re-sending a backup who has since been deactivated (a web
  // tab opened before the section stopped re-sending it, or any other client)
  // got a 400 on every save of an unrelated field. B1's follow-up already
  // texts that backup nothing and lets them approve nothing; keeping the
  // value on file is not making them the backup.
  describe('a deactivated backup already on file', () => {
    let deactivated: string;
    beforeEach(async () => {
      deactivated = await member('dispatcher');
      await settingsRepo.update(TENANT, { backupSupervisorUserId: deactivated });
      await users.deactivateMember(TENANT, deactivated);
    });

    it('re-sending the unchanged backup with a routing change saves', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ backupSupervisorUserId: deactivated, unsupervisedProposalRouting: 'queue_only' });

      expect(res.status).toBe(200);
      expect(res.body.backupSupervisorUserId).toBe(deactivated);
      expect((await getSettings(TENANT, settingsRepo))?.unsupervisedProposalRouting).toBe('queue_only');
    });

    it('changing to another deactivated member is still refused', async () => {
      const other = await member('dispatcher');
      await users.deactivateMember(TENANT, other);

      const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: other });

      expect(res.status).toBe(400);
      expect(res.body.details.field).toBe('backupSupervisorUserId');
      expect((await getSettings(TENANT, settingsRepo))?.backupSupervisorUserId).toBe(deactivated);
    });

    it("changing to another tenant's member is still refused", async () => {
      const foreign = await users.create!({
        id: crypto.randomUUID(),
        tenantId: 'tenant-elsewhere',
        email: `foreign-${Math.random().toString(36).slice(2)}@example.com`,
        role: 'dispatcher',
        canFieldServe: false,
      });

      const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: foreign.id });

      expect(res.status).toBe(400);
      expect(res.body.details.field).toBe('backupSupervisorUserId');
      expect((await getSettings(TENANT, settingsRepo))?.backupSupervisorUserId).toBe(deactivated);
    });
  });

  // Codex P2 on #1810 — the unchanged check reads the stored backup in one
  // statement and the save writes in another. The save still WROTE the value
  // it was sent, so a request that re-sent backup A with a routing change, and
  // was overtaken by a save that made B the backup, put A back, unchecked: a
  // deactivated or non-approving member could become the backup again. An
  // unchanged value is now left out of the write; the request saves only what
  // it changes.
  describe('an unchanged backup is left out of the write', () => {
    it('saves the routing change without writing or recording the backup', async () => {
      const backup = await member('dispatcher');
      await settingsRepo.update(TENANT, { backupSupervisorUserId: backup });
      const write = vi.spyOn(settingsRepo, 'update');

      const res = await request(app)
        .put('/api/settings')
        .send({ backupSupervisorUserId: backup, unsupervisedProposalRouting: 'queue_only' });

      expect(res.status).toBe(200);
      expect(res.body.backupSupervisorUserId).toBe(backup);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][1]).not.toHaveProperty('backupSupervisorUserId');
      expect(write.mock.calls[0][1]).toMatchObject({ unsupervisedProposalRouting: 'queue_only' });
      const stored = await getSettings(TENANT, settingsRepo);
      expect(stored).toMatchObject({ backupSupervisorUserId: backup, unsupervisedProposalRouting: 'queue_only' });
      const events = await audit.findByEntity(TENANT, 'tenant_settings', stored!.id);
      expect(events.map((e) => e.metadata)).toEqual([{ changedKeys: ['unsupervisedProposalRouting'] }]);
    });

    it('a backup changed while the request was in flight is not put back', async () => {
      const first = await member('dispatcher');
      const second = await member('dispatcher');
      await settingsRepo.update(TENANT, { backupSupervisorUserId: first });
      await users.deactivateMember(TENANT, first);
      // Another save makes `second` the backup after this request read
      // `first` as the stored value and before it writes.
      const write = settingsRepo.update.bind(settingsRepo);
      vi.spyOn(settingsRepo, 'update').mockImplementationOnce(async (...args) => {
        await write(TENANT, { backupSupervisorUserId: second });
        return write(...args);
      });

      const res = await request(app)
        .put('/api/settings')
        .send({ backupSupervisorUserId: first, unsupervisedProposalRouting: 'queue_only' });

      expect(res.status).toBe(200);
      expect(await getSettings(TENANT, settingsRepo)).toMatchObject({
        backupSupervisorUserId: second,
        unsupervisedProposalRouting: 'queue_only',
      });
    });
  });
});
