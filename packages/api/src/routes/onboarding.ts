import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { SettingsRepository, TenantSettings } from '../settings/settings';
import { PackActivationRepository, activatePack } from '../settings/pack-activation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { v4 as uuidv4 } from 'uuid';

interface OnboardingConfigureBody {
  name: string;
  businessName: string;
  services: string[];
  teamSize: string;
  workerTerm: string;
  jobTerm: string;
  estimateTerm: string;
  automationRules: { id: string; enabled: boolean }[];
}

/** Map onboarding service names to vertical pack IDs. */
const SERVICE_TO_PACK: Record<string, string> = {
  HVAC: 'hvac',
  Plumbing: 'plumbing',
  Painting: 'painting',
  Electrical: 'electrical',
  Contracting: 'contracting',
};

export function createOnboardingRouter(
  settingsRepo: SettingsRepository,
  packActivationRepo: PackActivationRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.post(
    '/configure',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as OnboardingConfigureBody;
      const tenantId = req.auth!.tenantId;
      const userId = req.auth!.userId;

      // Validate required fields
      if (!body?.businessName) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessName is required' });
        return;
      }

      const terminologyPreferences: Record<string, string> = {};
      if (body.workerTerm) terminologyPreferences.workerTerm = body.workerTerm;
      if (body.jobTerm) terminologyPreferences.jobTerm = body.jobTerm;
      if (body.estimateTerm) terminologyPreferences.estimateTerm = body.estimateTerm;
      if (body.teamSize) terminologyPreferences.teamSize = body.teamSize;
      if (body.name) terminologyPreferences.ownerName = body.name;

      // Upsert tenant settings
      const existing = await settingsRepo.findByTenant(tenantId);
      let settings: TenantSettings | null;

      if (existing) {
        settings = await settingsRepo.update(tenantId, {
          businessName: body.businessName,
          terminologyPreferences,
          activeVerticalPacks: body.services
            .map(s => SERVICE_TO_PACK[s])
            .filter(Boolean),
        });
      } else {
        settings = await settingsRepo.create({
          id: uuidv4(),
          tenantId,
          businessName: body.businessName,
          timezone: 'America/New_York',
          estimatePrefix: 'EST-',
          invoicePrefix: 'INV-',
          nextEstimateNumber: 1001,
          nextInvoiceNumber: 1001,
          defaultPaymentTermDays: 30,
          terminologyPreferences,
          activeVerticalPacks: body.services
            .map(s => SERVICE_TO_PACK[s])
            .filter(Boolean),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Activate vertical packs for selected services
      for (const service of body.services) {
        const packId = SERVICE_TO_PACK[service];
        if (!packId) continue;
        try {
          await activatePack({ tenantId, packId }, packActivationRepo);
        } catch {
          // Pack already active — ignore
        }
      }

      // Emit audit event
      await auditRepo.create(createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: 'owner',
        eventType: existing ? 'onboarding_update' : 'onboarding_complete',
        entityType: 'tenant_settings',
        entityId: settings?.id || tenantId,
        metadata: {
          businessName: body.businessName,
          services: body.services,
          teamSize: body.teamSize,
          terminology: terminologyPreferences,
          automationRules: body.automationRules,
        },
      }));

      res.json({
        settings,
        activatedPacks: body.services.map(s => SERVICE_TO_PACK[s]).filter(Boolean),
      });
    }
  );

  return router;
}
