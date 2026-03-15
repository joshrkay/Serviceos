import { VerticalActivation, VerticalActivationRepository } from './vertical-activation';
import { VerticalPack, VerticalPackRepository } from '../verticals/vertical-pack';

export interface ActiveVerticalSummary {
  verticalSlug: string;
  packName: string;
  activatedAt: Date;
  config?: Record<string, unknown>;
}

export interface VerticalPackSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
}

export interface VerticalSettingsView {
  tenantId: string;
  activeVerticals: ActiveVerticalSummary[];
  availablePacks: VerticalPackSummary[];
}

export async function getVerticalSettings(
  tenantId: string,
  activationRepo: VerticalActivationRepository,
  packRepo: VerticalPackRepository
): Promise<VerticalSettingsView> {
  const activations = await activationRepo.findByTenant(tenantId);
  const activeActivations = activations.filter((a) => a.isActive);
  const allPacks = await packRepo.findActive();

  const activeVerticals: ActiveVerticalSummary[] = [];
  for (const activation of activeActivations) {
    const pack = allPacks.find((p) => p.id === activation.verticalPackId);
    activeVerticals.push({
      verticalSlug: activation.verticalSlug,
      packName: pack ? pack.name : activation.verticalSlug,
      activatedAt: activation.activatedAt,
      config: activation.config,
    });
  }

  const availablePacks: VerticalPackSummary[] = allPacks.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    version: p.version,
  }));

  return { tenantId, activeVerticals, availablePacks };
}

export function formatVerticalSettingsForApi(view: VerticalSettingsView): Record<string, unknown> {
  return {
    tenantId: view.tenantId,
    activeVerticals: view.activeVerticals.map((v) => ({
      slug: v.verticalSlug,
      name: v.packName,
      activatedAt: v.activatedAt.toISOString(),
      config: v.config || {},
    })),
    availablePacks: view.availablePacks.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      version: p.version,
    })),
  };
}
