// Onboarding pack seeding — turns a pack activation into a usable tenant
// workspace. Without this, a new tenant picks "HVAC" in Step 3 of the
// onboarding wizard and lands on an empty estimate page.
//
// We seed three things per pack:
//   1. catalog_items — price-book entries (labor rates, diagnostic fees,
//      common parts) so the operator can build line items.
//   2. estimate_templates — job-type templates per service category so the
//      operator can pick "Standard AC Repair" instead of starting blank.
//   3. estimate_templates.default_customer_message — message templates
//      attached to each job type. Note: there's no standalone
//      `message_templates` table yet (see TODO below).
//
// TODO(post-launch): The PackStep UI advertises "18 message templates" for
// HVAC. We currently bundle the customer-facing copy into each
// estimate_template's defaultCustomerMessage. Once we add a dedicated
// `message_templates` table (for SMS/email comms separate from estimate
// copy), revisit and split these out.

import { v4 as uuidv4 } from 'uuid';

import {
  CatalogCategory,
  CatalogItem,
  CatalogItemRepository,
  CatalogUnit,
} from '../catalog/catalog-item';
import {
  EstimateTemplate,
  EstimateTemplateRepository,
  LineItemTemplate,
} from '../templates/estimate-template';
import { VerticalType } from '../verticals/registry';
import {
  HVAC_LINE_ITEM_DEFAULTS,
} from '../verticals/packs/hvac';
import {
  PLUMBING_LINE_ITEM_DEFAULTS,
} from '../verticals/packs/plumbing';

export interface SeedPackDefaultsDeps {
  catalogRepo: CatalogItemRepository;
  templateRepo: EstimateTemplateRepository;
}

export interface SeedPackDefaultsInput {
  tenantId: string;
  /** Normalized pack id from the wizard ("hvac" | "plumbing"). */
  packId: string;
  /** Audit / provenance — defaults to a synthetic system actor. */
  actorId?: string;
}

export interface SeedPackDefaultsResult {
  packId: string;
  catalogItemsCreated: number;
  templatesCreated: number;
  /**
   * True when the function found pre-existing seeded data for this pack and
   * skipped writes. Idempotency: the wizard's POST handler can call this on
   * every activation without duplicating rows.
   */
  alreadySeeded: boolean;
}

// ---- Catalog seed templates --------------------------------------------------

interface CatalogSeed {
  name: string;
  description: string;
  category: CatalogCategory;
  unit: CatalogUnit;
  unitPriceCents: number;
}

function hvacCatalogSeeds(): CatalogSeed[] {
  const d = HVAC_LINE_ITEM_DEFAULTS;
  return [
    {
      name: 'HVAC Labor',
      description: 'Standard HVAC technician hourly labor.',
      category: 'Labor',
      unit: 'hour',
      unitPriceCents: d.laborRatePerHourCents,
    },
    {
      name: 'Diagnostic Fee',
      description: 'Trip + diagnostic to inspect the system on site.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.diagnosticFeeCents,
    },
    {
      name: 'Emergency Call Fee',
      description: 'After-hours / same-day emergency dispatch fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.emergencyCallFeeCents,
    },
    {
      name: 'Trip Charge',
      description: 'Standard truck roll fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.tripChargeCents,
    },
    {
      name: 'Seasonal Tune-Up',
      description: 'Pre-season inspection, cleaning, and performance check.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.seasonalTuneUpCents,
    },
    {
      name: 'Filter Replacement',
      description: 'Standard 1-inch HVAC return filter.',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: d.filterReplacementCents,
    },
  ];
}

function plumbingCatalogSeeds(): CatalogSeed[] {
  const d = PLUMBING_LINE_ITEM_DEFAULTS;
  return [
    {
      name: 'Plumbing Labor',
      description: 'Standard plumber hourly labor.',
      category: 'Labor',
      unit: 'hour',
      unitPriceCents: d.laborRatePerHourCents,
    },
    {
      name: 'Diagnostic Fee',
      description: 'Trip + diagnostic to locate the issue on site.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.diagnosticFeeCents,
    },
    {
      name: 'Emergency Call Fee',
      description: 'After-hours / same-day emergency dispatch fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.emergencyCallFeeCents,
    },
    {
      name: 'Trip Charge',
      description: 'Standard truck roll fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.tripChargeCents,
    },
    {
      name: 'Drain Cleaning',
      description: 'Snake / clear a single drain line.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.drainCleaningCents,
    },
    {
      name: 'Camera Inspection',
      description: 'Sewer / drain camera inspection.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.cameraInspectionCents,
    },
  ];
}

// ---- Estimate template (job type) seeds --------------------------------------

interface EstimateTemplateSeed {
  categoryId: string;
  name: string;
  description: string;
  customerMessage: string;
  lineItems: LineItemTemplate[];
}

function hvacTemplateSeeds(): EstimateTemplateSeed[] {
  const d = HVAC_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'hvac-diagnostic',
      name: 'AC / Heating Diagnostic Visit',
      description: 'On-site diagnostic to determine the cause of an HVAC issue.',
      customerMessage:
        "Thanks for choosing us. Our technician will diagnose the issue, walk you through what's needed, and quote any repairs before any work begins.",
      lineItems: [
        {
          description: 'Diagnostic + trip fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.diagnosticFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'hvac-repair-ac',
      name: 'Standard AC Repair',
      description: 'Diagnostic + 1 hour of repair labor for a typical AC issue.',
      customerMessage:
        "Here's the estimate to repair your AC. The diagnostic fee is included — you only pay for the repair time and any parts.",
      lineItems: [
        {
          description: 'Diagnostic + trip fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.diagnosticFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
        {
          description: 'AC repair labor',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.laborRatePerHourCents,
          taxable: false,
          sortOrder: 2,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'hvac-maint-tuneup',
      name: 'Seasonal Tune-Up',
      description: 'Pre-season inspection, cleaning, and performance check.',
      customerMessage:
        "We'll inspect, clean, and tune up your system so it runs reliably this season.",
      lineItems: [
        {
          description: 'Seasonal tune-up',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.seasonalTuneUpCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'hvac-install-thermostat',
      name: 'Thermostat Install',
      description: 'Install a customer-supplied thermostat (1 hour labor).',
      customerMessage:
        "Here's the estimate to install your thermostat. If you'd like us to supply a smart thermostat instead, we'll provide options on site.",
      lineItems: [
        {
          description: 'Thermostat install labor',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.laborRatePerHourCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'hvac-emergency',
      name: 'After-Hours Emergency Service',
      description: 'Emergency dispatch for no-heat / no-cool calls.',
      customerMessage:
        "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.",
      lineItems: [
        {
          description: 'Emergency dispatch fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.emergencyCallFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
  ];
}

function plumbingTemplateSeeds(): EstimateTemplateSeed[] {
  const d = PLUMBING_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'plumb-diagnostic',
      name: 'Plumbing Diagnostic Visit',
      description: 'On-site diagnostic to determine the cause of a plumbing issue.',
      customerMessage:
        "Thanks for choosing us. Our technician will diagnose the issue and quote any repairs before any work begins.",
      lineItems: [
        {
          description: 'Diagnostic + trip fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.diagnosticFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'plumb-repair-leak',
      name: 'Leak Repair',
      description: 'Diagnostic + 1 hour of repair labor for a typical leak.',
      customerMessage:
        "Here's the estimate to repair the leak. The diagnostic fee is included — you only pay for the repair time and any parts.",
      lineItems: [
        {
          description: 'Diagnostic + trip fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.diagnosticFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
        {
          description: 'Leak repair labor',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.laborRatePerHourCents,
          taxable: false,
          sortOrder: 2,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'plumb-maint-drain-clean',
      name: 'Drain Cleaning',
      description: 'Snake / clear a single drain line.',
      customerMessage:
        "We'll clear the drain and confirm the line is flowing freely before we leave.",
      lineItems: [
        {
          description: 'Drain cleaning',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.drainCleaningCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'plumb-diagnostic',
      name: 'Sewer Camera Inspection',
      description: 'Camera inspection to locate sewer / main line issues.',
      customerMessage:
        "We'll run a camera through your sewer line and show you exactly what we find on the screen.",
      lineItems: [
        {
          description: 'Camera inspection',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.cameraInspectionCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
    {
      categoryId: 'plumb-emergency',
      name: 'After-Hours Emergency Plumbing',
      description: 'Emergency dispatch for burst pipes / flooding / no-water calls.',
      customerMessage:
        "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.",
      lineItems: [
        {
          description: 'Emergency dispatch fee',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: d.emergencyCallFeeCents,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
        },
      ],
    },
  ];
}

// ---- Registry ---------------------------------------------------------------

interface PackSeedConfig {
  verticalType: VerticalType;
  catalogSeeds: () => CatalogSeed[];
  templateSeeds: () => EstimateTemplateSeed[];
}

const PACK_SEEDS: Record<string, PackSeedConfig> = {
  hvac: {
    verticalType: 'hvac',
    catalogSeeds: hvacCatalogSeeds,
    templateSeeds: hvacTemplateSeeds,
  },
  plumbing: {
    verticalType: 'plumbing',
    catalogSeeds: plumbingCatalogSeeds,
    templateSeeds: plumbingTemplateSeeds,
  },
};

export function isSeedablePackId(packId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PACK_SEEDS, packId);
}

/**
 * Seed canonical catalog items + estimate templates for the given pack.
 *
 * Idempotent: probes the template repo first for a previously-seeded
 * template (vertical + categoryId + name match). If one exists we treat
 * the seed as already done and return `alreadySeeded: true` without
 * writing — so the onboarding wizard's POST /api/onboarding/pack handler
 * can call this on every activation (including reactivations).
 *
 * Returns counts of what was created. On unknown packId we no-op and
 * return zero counts — callers shouldn't treat that as an error since
 * the wizard's PackPickInputSchema already enforces the allowed set.
 */
export async function seedPackDefaults(
  input: SeedPackDefaultsInput,
  deps: SeedPackDefaultsDeps,
): Promise<SeedPackDefaultsResult> {
  const { tenantId, packId } = input;
  const actorId = input.actorId ?? 'system';
  const config = PACK_SEEDS[packId];

  if (!config) {
    return {
      packId,
      catalogItemsCreated: 0,
      templatesCreated: 0,
      alreadySeeded: false,
    };
  }

  // Idempotency probe: if any template for this vertical already exists
  // with a name we'd seed, treat the pack as already seeded. The schema
  // has no `seed_source` column, so we rely on name + vertical_type as
  // the natural key. Cheap (single SELECT) on the templates table —
  // estimate_templates is indexed on (tenant_id, vertical_type).
  const templateSeeds = config.templateSeeds();
  const existingTemplates = await deps.templateRepo.findByVertical(
    tenantId,
    config.verticalType,
  );
  const seededNames = new Set(templateSeeds.map((s) => s.name));
  const alreadySeeded = existingTemplates.some((t) => seededNames.has(t.name));

  if (alreadySeeded) {
    return {
      packId,
      catalogItemsCreated: 0,
      templatesCreated: 0,
      alreadySeeded: true,
    };
  }

  // Seed catalog items. Also idempotency-check by name to be safe in case
  // an admin pre-populated the price book by hand.
  const existingCatalog = await deps.catalogRepo.listByTenant(tenantId, {
    includeArchived: false,
  });
  const existingCatalogNames = new Set(
    existingCatalog.map((c) => c.name.toLowerCase()),
  );

  const now = new Date().toISOString();
  let catalogItemsCreated = 0;
  for (const seed of config.catalogSeeds()) {
    if (existingCatalogNames.has(seed.name.toLowerCase())) {
      continue;
    }
    const item: CatalogItem = {
      id: uuidv4(),
      tenantId,
      name: seed.name,
      description: seed.description,
      category: seed.category,
      unit: seed.unit,
      unitPriceCents: seed.unitPriceCents,
      productServiceType: seed.category === 'Labor' ? 'service' : 'product',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await deps.catalogRepo.create(item);
    catalogItemsCreated += 1;
  }

  // Seed estimate templates (job types).
  let templatesCreated = 0;
  const seedDate = new Date();
  for (const seed of templateSeeds) {
    const template: EstimateTemplate = {
      id: uuidv4(),
      tenantId,
      verticalType: config.verticalType,
      categoryId: seed.categoryId,
      name: seed.name,
      description: seed.description,
      lineItemTemplates: seed.lineItems,
      defaultDiscountCents: 0,
      defaultTaxRateBps: 0,
      defaultCustomerMessage: seed.customerMessage,
      isActive: true,
      usageCount: 0,
      createdBy: actorId,
      createdAt: seedDate,
      updatedAt: seedDate,
    };
    await deps.templateRepo.create(template);
    templatesCreated += 1;
  }

  return {
    packId,
    catalogItemsCreated,
    templatesCreated,
    alreadySeeded: false,
  };
}
