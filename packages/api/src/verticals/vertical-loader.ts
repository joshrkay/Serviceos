import { VerticalPack, VerticalPackRepository } from './vertical-pack';
import { TerminologyMap, TerminologyMapRepository } from './terminology-map';
import { ServiceTaxonomy, ServiceTaxonomyRepository } from './service-taxonomy';
import { VerticalActivationRepository } from '../settings/vertical-activation';

export interface LoadedVerticalPack {
  pack: VerticalPack;
  terminology: TerminologyMap;
  taxonomy: ServiceTaxonomy;
}

export interface VerticalLoader {
  loadForTenant(tenantId: string): Promise<LoadedVerticalPack[]>;
  loadBySlug(slug: string): Promise<LoadedVerticalPack | null>;
}

export function createVerticalLoader(
  packRepo: VerticalPackRepository,
  termRepo: TerminologyMapRepository,
  taxRepo: ServiceTaxonomyRepository,
  activationRepo: VerticalActivationRepository
): VerticalLoader {
  return {
    async loadForTenant(tenantId: string): Promise<LoadedVerticalPack[]> {
      const activations = await activationRepo.findByTenant(tenantId);
      const activeActivations = activations.filter((a) => a.isActive);
      const results: LoadedVerticalPack[] = [];

      for (const activation of activeActivations) {
        const pack = await packRepo.findById(activation.verticalPackId);
        if (!pack || !pack.isActive) continue;

        const terminology = await termRepo.findById(pack.terminologyMapId);
        const taxonomy = await taxRepo.findById(pack.taxonomyId);
        if (!terminology || !taxonomy) continue;

        results.push({ pack, terminology, taxonomy });
      }

      return results;
    },

    async loadBySlug(slug: string): Promise<LoadedVerticalPack | null> {
      const pack = await packRepo.findBySlug(slug);
      if (!pack || !pack.isActive) return null;

      const terminology = await termRepo.findById(pack.terminologyMapId);
      const taxonomy = await taxRepo.findById(pack.taxonomyId);
      if (!terminology || !taxonomy) return null;

      return { pack, terminology, taxonomy };
    },
  };
}

export function validatePackIntegrity(loaded: LoadedVerticalPack): string[] {
  const errors: string[] = [];
  if (loaded.pack.terminologyMapId !== loaded.terminology.id) {
    errors.push('Terminology map ID mismatch');
  }
  if (loaded.pack.taxonomyId !== loaded.taxonomy.id) {
    errors.push('Taxonomy ID mismatch');
  }
  if (loaded.terminology.verticalSlug !== loaded.pack.slug) {
    errors.push('Terminology vertical slug does not match pack slug');
  }
  if (loaded.taxonomy.verticalSlug !== loaded.pack.slug) {
    errors.push('Taxonomy vertical slug does not match pack slug');
  }
  if (loaded.terminology.entries.length === 0) {
    errors.push('Terminology map has no entries');
  }
  if (loaded.taxonomy.categories.length === 0) {
    errors.push('Taxonomy has no categories');
  }
  return errors;
}
