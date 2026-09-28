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
  /** Normalized pack id from the wizard. 'hvac' | 'plumbing' are the
   *  original packs; 'electrical' | 'roofing' | 'painting' | 'gc_remodel'
   *  | 'landscaping' | 'concrete' | 'other' were added so every trade can
   *  complete setup. */
  packId: string;
  /**
   * Free-text trade name typed by the operator in the "Other" picker
   * (carried from PackPickInputSchema.tradeLabel). Only used when
   * packId === 'other', to label the generic seeds ("Pool Service
   * Labor" instead of "General Labor"). Ignored otherwise.
   */
  tradeLabel?: string;
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

// Catalog seed names are pack-prefixed (e.g. "HVAC Diagnostic Fee" vs
// "Plumbing Diagnostic Fee") so a multi-pack tenant gets both sets at
// their pack-specific prices. The name-only idempotency probe below
// would otherwise treat the plumbing seed as a duplicate of HVAC's and
// silently skip the price difference (HVAC $89 vs plumbing $75 etc.).
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
      name: 'HVAC Diagnostic Fee',
      description: 'Trip + diagnostic to inspect the system on site.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.diagnosticFeeCents,
    },
    {
      name: 'HVAC Emergency Call Fee',
      description: 'After-hours / same-day emergency dispatch fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.emergencyCallFeeCents,
    },
    {
      name: 'HVAC Trip Charge',
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
      name: 'Plumbing Diagnostic Fee',
      description: 'Trip + diagnostic to locate the issue on site.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.diagnosticFeeCents,
    },
    {
      name: 'Plumbing Emergency Call Fee',
      description: 'After-hours / same-day emergency dispatch fee.',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: d.emergencyCallFeeCents,
    },
    {
      name: 'Plumbing Trip Charge',
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

// ---- Additional pack defaults (added alongside the enum expansion) --------

// Electrical and painting have full vertical packs (taxonomy / AI scripts in
// verticals/packs/{electrical,painting}.ts) but, unlike hvac/plumbing, never
// got LINE_ITEM_DEFAULTS — so their seed pricing lives here next to the
// other new trades rather than in those files. The rest of the trades have
// no vertical pack at all yet; the seeds below are sensible standalone
// defaults following the hvac/plumbing structure (labor, diagnostic,
// emergency, trip charge + specialty items / job types).
const ELECTRICAL_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 13500, // $135/hr
  diagnosticFeeCents: 8900, // $89
  emergencyCallFeeCents: 17500, // $175
  tripChargeCents: 4900, // $49
  panelUpgradeCents: 24900, // $249
  fixtureInstallCents: 11900, // $119
};

const PAINTING_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 8500, // $85/hr
  diagnosticFeeCents: 7500, // $75 estimate walk-through
  emergencyCallFeeCents: 15000, // $150
  tripChargeCents: 3900, // $39
  interiorRoomCents: 24900, // $249 per standard room
  exteriorJobCents: 49900, // $499 exterior package
};

const ROOFING_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 12000, // $120/hr
  inspectionFeeCents: 9900, // $99
  emergencyCallFeeCents: 25000, // $250
  tripChargeCents: 4900, // $49
  leakRepairCents: 34900, // $349
  gutterRepairCents: 19900, // $199
};

const GC_REMODEL_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 15000, // $150/hr
  consultationFeeCents: 14900, // $149
  emergencyCallFeeCents: 20000, // $200
  tripChargeCents: 4900, // $49
  dayRateCents: 96000, // $960 project day rate
  punchListCents: 24900, // $249
};

const LANDSCAPING_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 7500, // $75/hr
  assessmentFeeCents: 4900, // $49 site assessment
  emergencyCallFeeCents: 15000, // $150
  tripChargeCents: 3900, // $39
  lawnCareCents: 9900, // $99 per visit
  irrigationRepairCents: 14900, // $149
};

const CONCRETE_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 11000, // $110/hr
  siteVisitFeeCents: 9900, // $99
  emergencyCallFeeCents: 20000, // $200
  tripChargeCents: 4900, // $49
  slabPourCents: 59900, // $599 standard slab
  removalCents: 24900, // $249
};

const GENERIC_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 10000, // $100/hr
  diagnosticFeeCents: 8900, // $89
  emergencyCallFeeCents: 15000, // $150
  tripChargeCents: 4900, // $49
};

/** Prefix for 'other' generic seeds — the operator's free-text trade label
 * ("Pool Service Labor") or "General" when none was given. */
function genericTradePrefix(tradeLabel: string): string {
  const label = tradeLabel.trim();
  return label ? label : 'General';
}

function electricalCatalogSeeds(): CatalogSeed[] {
  const d = ELECTRICAL_LINE_ITEM_DEFAULTS;
  return [
    { name: 'Electrical Labor', description: 'Standard electrician hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Electrical Diagnostic Fee', description: 'Trip + diagnostic to trace the issue on site.', category: 'Labor', unit: 'each', unitPriceCents: d.diagnosticFeeCents },
    { name: 'Electrical Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'Electrical Trip Charge', description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Panel Upgrade', description: 'Panel / breaker panel upgrade, standard residential.', category: 'Labor', unit: 'each', unitPriceCents: d.panelUpgradeCents },
    { name: 'Fixture / Ceiling Fan Install', description: 'Install a customer-supplied fixture or ceiling fan.', category: 'Labor', unit: 'each', unitPriceCents: d.fixtureInstallCents },
  ];
}

function paintingCatalogSeeds(): CatalogSeed[] {
  const d = PAINTING_LINE_ITEM_DEFAULTS;
  return [
    { name: 'Painting Labor', description: 'Standard painter hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Painting Estimate Fee', description: 'On-site walk-through, measurements, and written estimate.', category: 'Labor', unit: 'each', unitPriceCents: d.diagnosticFeeCents },
    { name: 'Painting Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'Painting Trip Charge', description: 'Standard trip fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Interior Room Paint', description: 'Walls + ceiling for a standard room, paint not included.', category: 'Labor', unit: 'each', unitPriceCents: d.interiorRoomCents },
    { name: 'Exterior Paint Package', description: 'Exterior repaint package for a typical single-story home.', category: 'Labor', unit: 'each', unitPriceCents: d.exteriorJobCents },
  ];
}

function roofingCatalogSeeds(): CatalogSeed[] {
  const d = ROOFING_LINE_ITEM_DEFAULTS;
  return [
    { name: 'Roofing Labor', description: 'Standard roofing crew hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Roof Inspection Fee', description: 'On-site roof inspection with written findings.', category: 'Labor', unit: 'each', unitPriceCents: d.inspectionFeeCents },
    { name: 'Roofing Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'Roofing Trip Charge', description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Leak Repair', description: 'Locate and repair a single roof leak.', category: 'Labor', unit: 'each', unitPriceCents: d.leakRepairCents },
    { name: 'Gutter Repair', description: 'Repair a section of gutter / downspout.', category: 'Labor', unit: 'each', unitPriceCents: d.gutterRepairCents },
  ];
}

function gcRemodelCatalogSeeds(): CatalogSeed[] {
  const d = GC_REMODEL_LINE_ITEM_DEFAULTS;
  return [
    { name: 'GC Labor', description: 'General contracting hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Site Consultation Fee', description: 'On-site consultation with written scope.', category: 'Labor', unit: 'each', unitPriceCents: d.consultationFeeCents },
    { name: 'GC Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'GC Trip Charge', description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Punch List / Small Repair', description: 'Small repairs and punch-list items, flat rate.', category: 'Labor', unit: 'each', unitPriceCents: d.punchListCents },
    { name: 'Project Day Rate', description: 'Full crew day rate for a single project day.', category: 'Labor', unit: 'each', unitPriceCents: d.dayRateCents },
  ];
}

function landscapingCatalogSeeds(): CatalogSeed[] {
  const d = LANDSCAPING_LINE_ITEM_DEFAULTS;
  return [
    { name: 'Landscaping Labor', description: 'Standard landscaping crew hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Site Assessment Fee', description: 'On-site assessment with written recommendations.', category: 'Labor', unit: 'each', unitPriceCents: d.assessmentFeeCents },
    { name: 'Landscaping Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'Landscaping Trip Charge', description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Lawn Care Visit', description: 'Mow, edge, and blow for a typical residential yard.', category: 'Labor', unit: 'each', unitPriceCents: d.lawnCareCents },
    { name: 'Irrigation Repair', description: 'Diagnose and repair a sprinkler / irrigation zone.', category: 'Labor', unit: 'each', unitPriceCents: d.irrigationRepairCents },
  ];
}

function concreteCatalogSeeds(): CatalogSeed[] {
  const d = CONCRETE_LINE_ITEM_DEFAULTS;
  return [
    { name: 'Concrete Labor', description: 'Standard concrete crew hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: 'Site Visit / Measurement Fee', description: 'On-site visit, measurements, and written estimate.', category: 'Labor', unit: 'each', unitPriceCents: d.siteVisitFeeCents },
    { name: 'Concrete Emergency Call Fee', description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: 'Concrete Trip Charge', description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
    { name: 'Slab Pour', description: 'Standard concrete slab pour, form and finish.', category: 'Labor', unit: 'each', unitPriceCents: d.slabPourCents },
    { name: 'Concrete Removal', description: 'Break out and haul away existing concrete.', category: 'Labor', unit: 'each', unitPriceCents: d.removalCents },
  ];
}

function genericCatalogSeeds(tradeLabel: string): CatalogSeed[] {
  const d = GENERIC_LINE_ITEM_DEFAULTS;
  const p = genericTradePrefix(tradeLabel);
  return [
    { name: `${p} Labor`, description: 'Standard hourly labor.', category: 'Labor', unit: 'hour', unitPriceCents: d.laborRatePerHourCents },
    { name: `${p} Diagnostic Fee`, description: 'Trip + diagnostic to assess the job on site.', category: 'Labor', unit: 'each', unitPriceCents: d.diagnosticFeeCents },
    { name: `${p} Emergency Call Fee`, description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: d.emergencyCallFeeCents },
    { name: `${p} Trip Charge`, description: 'Standard truck roll fee.', category: 'Labor', unit: 'each', unitPriceCents: d.tripChargeCents },
  ];
}

function electricalTemplateSeeds(): EstimateTemplateSeed[] {
  const d = ELECTRICAL_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'electrical-diagnostic',
      name: 'Electrical Diagnostic Visit',
      description: 'On-site diagnostic to trace an electrical issue.',
      customerMessage: "Thanks for choosing us. Our electrician will trace the issue, walk you through what's needed, and quote any work before we begin.",
      lineItems: [
        { description: 'Diagnostic + trip fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.diagnosticFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'electrical-repair',
      name: 'Troubleshooting & Repair',
      description: 'Diagnostic + 1 hour of repair labor for a typical issue.',
      customerMessage: "Here's the estimate for the repair. The diagnostic fee is included — you only pay for the repair time and any parts.",
      lineItems: [
        { description: 'Diagnostic + trip fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.diagnosticFeeCents, taxable: false, sortOrder: 1, isOptional: false },
        { description: 'Repair labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 2, isOptional: false },
      ],
    },
    {
      categoryId: 'electrical-panel',
      name: 'Panel Upgrade',
      description: 'Residential breaker panel upgrade.',
      customerMessage: "Here's the estimate for your panel upgrade. We'll handle permits and coordinate the power-company shutoff.",
      lineItems: [
        { description: 'Panel upgrade', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.panelUpgradeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'electrical-lighting',
      name: 'Fixture / Ceiling Fan Install',
      description: 'Install a customer-supplied fixture or ceiling fan.',
      customerMessage: "Here's the estimate to install your fixture. If the box needs bracing for a fan, we'll let you know before we start.",
      lineItems: [
        { description: 'Fixture install', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.fixtureInstallCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'electrical-emergency',
      name: 'After-Hours Emergency Electrical',
      description: 'Emergency dispatch for outages / sparking / safety hazards.',
      customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

function paintingTemplateSeeds(): EstimateTemplateSeed[] {
  const d = PAINTING_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'painting-diagnostic',
      name: 'Estimate Walk-Through',
      description: 'On-site walk-through, measurements, and written estimate.',
      customerMessage: "Thanks for having us out. Here's the written estimate based on the walk-through — no obligation.",
      lineItems: [
        { description: 'Estimate walk-through', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.diagnosticFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'painting-interior',
      name: 'Interior Room Paint',
      description: 'Walls + ceiling for a standard room, two coats.',
      customerMessage: "Here's the estimate for the room. We move and cover furniture, prep every surface, and leave it spotless.",
      lineItems: [
        { description: 'Interior room paint (labor)', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.interiorRoomCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'painting-exterior',
      name: 'Exterior Paint',
      description: 'Exterior repaint for a typical single-story home.',
      customerMessage: "Here's the estimate for the exterior. Includes pressure washing, prep, and two coats.",
      lineItems: [
        { description: 'Exterior paint package (labor)', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.exteriorJobCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'painting-prep',
      name: 'Surface Prep & Repair',
      description: 'Patching, sanding, and caulking ahead of paint.',
      customerMessage: "Good paint starts with prep. Here's the estimate for getting the surfaces ready.",
      lineItems: [
        { description: 'Prep labor', category: 'labor', defaultQuantity: 2, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'painting-finishing',
      name: 'Touch-Up & Finish',
      description: 'Small touch-ups and finish work.',
      customerMessage: "Here's the estimate for the touch-up work.",
      lineItems: [
        { description: 'Touch-up labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

function roofingTemplateSeeds(): EstimateTemplateSeed[] {
  const d = ROOFING_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'roofing-inspection',
      name: 'Roof Inspection',
      description: 'On-site roof inspection with photos and written findings.',
      customerMessage: "We'll walk the roof, photograph everything we find, and send you a written report with options.",
      lineItems: [
        { description: 'Roof inspection', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.inspectionFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'roofing-repair',
      name: 'Leak Repair',
      description: 'Locate and repair a single roof leak.',
      customerMessage: "Here's the estimate to stop the leak. We find the source — not just the stain — and warranty the repair.",
      lineItems: [
        { description: 'Leak repair', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.leakRepairCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'roofing-replacement',
      name: 'Shingle Replacement',
      description: 'Tear-off and replacement estimate for a typical roof.',
      customerMessage: "Here's the estimate for the replacement. Includes tear-off, decking check, underlayment, and cleanup.",
      lineItems: [
        { description: 'Replacement labor', category: 'labor', defaultQuantity: 8, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'roofing-emergency',
      name: 'Storm Damage Response',
      description: 'Emergency dispatch for storm damage / active leaks.',
      customerMessage: "We're on the way. We'll tarp it to stop the water first, then walk you through the repair options.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'roofing-gutters',
      name: 'Gutter Repair',
      description: 'Repair a section of gutter / downspout.',
      customerMessage: "Here's the estimate for the gutter repair.",
      lineItems: [
        { description: 'Gutter repair', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.gutterRepairCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

function gcRemodelTemplateSeeds(): EstimateTemplateSeed[] {
  const d = GC_REMODEL_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'gc-consult',
      name: 'Site Consultation',
      description: 'On-site consultation with written scope and budget range.',
      customerMessage: "Thanks for having us out. Here's the scope and budget range from the consultation — no obligation.",
      lineItems: [
        { description: 'Site consultation', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.consultationFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'gc-kitchen',
      name: 'Kitchen Remodel',
      description: 'Kitchen remodel estimate template — scope per consultation.',
      customerMessage: "Here's the estimate for the kitchen remodel based on our walk-through. Every line item is adjustable.",
      lineItems: [
        { description: 'Remodel labor (per day)', category: 'labor', defaultQuantity: 5, defaultUnitPriceCents: d.dayRateCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'gc-bathroom',
      name: 'Bathroom Remodel',
      description: 'Bathroom remodel estimate template — scope per consultation.',
      customerMessage: "Here's the estimate for the bathroom remodel based on our walk-through. Every line item is adjustable.",
      lineItems: [
        { description: 'Remodel labor (per day)', category: 'labor', defaultQuantity: 3, defaultUnitPriceCents: d.dayRateCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'gc-repair',
      name: 'Punch List / Small Repair',
      description: 'Small repairs and punch-list items, flat rate.',
      customerMessage: "Here's the flat-rate estimate for the punch list.",
      lineItems: [
        { description: 'Punch list / small repair', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.punchListCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'gc-emergency',
      name: 'Emergency Response',
      description: 'Emergency dispatch for storm / water / structural calls.',
      customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour on site. Any repair work will be quoted before we proceed.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

function landscapingTemplateSeeds(): EstimateTemplateSeed[] {
  const d = LANDSCAPING_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'landscape-cleanup',
      name: 'Yard Cleanup',
      description: 'One-time yard cleanup for a typical residential yard.',
      customerMessage: "Here's the estimate for the cleanup. We haul everything away and leave it looking right.",
      lineItems: [
        { description: 'Cleanup labor', category: 'labor', defaultQuantity: 4, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'landscape-maintenance',
      name: 'Lawn Care Visit',
      description: 'Mow, edge, and blow for a typical residential yard.',
      customerMessage: "Here's the per-visit price for lawn care. Ask about the seasonal plan for a standing schedule.",
      lineItems: [
        { description: 'Lawn care visit', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.lawnCareCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'landscape-install',
      name: 'Planting / Bed Install',
      description: 'New plantings and bed installation.',
      customerMessage: "Here's the estimate for the planting work. Plants are priced per the selection you approve.",
      lineItems: [
        { description: 'Planting labor', category: 'labor', defaultQuantity: 3, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'landscape-irrigation',
      name: 'Irrigation Repair',
      description: 'Diagnose and repair a sprinkler / irrigation zone.',
      customerMessage: "Here's the estimate for the irrigation repair. The assessment fee is included.",
      lineItems: [
        { description: 'Irrigation repair', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.irrigationRepairCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'landscape-emergency',
      name: 'Storm Cleanup',
      description: 'Emergency dispatch for storm debris / downed limbs.',
      customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of cleanup.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

function concreteTemplateSeeds(): EstimateTemplateSeed[] {
  const d = CONCRETE_LINE_ITEM_DEFAULTS;
  return [
    {
      categoryId: 'concrete-estimate',
      name: 'Site Visit / Measurement',
      description: 'On-site visit, measurements, and written estimate.',
      customerMessage: "Thanks for having us out. Here's the written estimate based on the measurements — no obligation.",
      lineItems: [
        { description: 'Site visit / measurement', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.siteVisitFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'concrete-pour',
      name: 'Slab / Driveway Pour',
      description: 'Standard concrete pour — form, pour, and finish.',
      customerMessage: "Here's the estimate for the pour. Includes forming, finishing, and cleanup.",
      lineItems: [
        { description: 'Concrete pour', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.slabPourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'concrete-repair',
      name: 'Crack & Surface Repair',
      description: 'Repair cracks and spalling on existing concrete.',
      customerMessage: "Here's the estimate for the repair work.",
      lineItems: [
        { description: 'Repair labor', category: 'labor', defaultQuantity: 2, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'concrete-removal',
      name: 'Concrete Removal',
      description: 'Break out and haul away existing concrete.',
      customerMessage: "Here's the estimate for the removal. We haul everything and leave the site clean.",
      lineItems: [
        { description: 'Concrete removal', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.removalCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'concrete-emergency',
      name: 'Emergency Service',
      description: 'Emergency dispatch for trip hazards / structural cracks.',
      customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour on site. Any repair work will be quoted before we proceed.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

// 'other' — generic safe defaults so a trade with no dedicated pack still
// lands on a usable price book and job types. When the operator typed a
// free-text label (tradeLabel), seed names carry it; otherwise they're
// plainly "General …" and editable.
function genericTemplateSeeds(tradeLabel: string): EstimateTemplateSeed[] {
  const d = GENERIC_LINE_ITEM_DEFAULTS;
  const p = genericTradePrefix(tradeLabel);
  return [
    {
      categoryId: 'general-diagnostic',
      name: `${p} Service Visit`,
      description: 'On-site visit to assess the job and provide an estimate.',
      customerMessage: "Thanks for choosing us. We'll assess the job on site and quote any work before we begin.",
      lineItems: [
        { description: 'Diagnostic + trip fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.diagnosticFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'general-repair',
      name: `${p} Repair`,
      description: 'Diagnostic + 1 hour of repair labor for a typical job.',
      customerMessage: "Here's the estimate for the repair. The diagnostic fee is included — you only pay for the repair time and any parts.",
      lineItems: [
        { description: 'Diagnostic + trip fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.diagnosticFeeCents, taxable: false, sortOrder: 1, isOptional: false },
        { description: 'Repair labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 2, isOptional: false },
      ],
    },
    {
      categoryId: 'general-install',
      name: `${p} Installation`,
      description: 'Standard installation, 2 hours of labor.',
      customerMessage: "Here's the estimate for the installation.",
      lineItems: [
        { description: 'Installation labor', category: 'labor', defaultQuantity: 2, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'general-maintenance',
      name: `${p} Maintenance Visit`,
      description: 'Scheduled maintenance visit, 1 hour of labor.',
      customerMessage: "Here's the estimate for the maintenance visit.",
      lineItems: [
        { description: 'Maintenance labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.laborRatePerHourCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
    {
      categoryId: 'general-emergency',
      name: `${p} After-Hours Emergency`,
      description: 'Emergency dispatch.',
      customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.",
      lineItems: [
        { description: 'Emergency dispatch fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: d.emergencyCallFeeCents, taxable: false, sortOrder: 1, isOptional: false },
      ],
    },
  ];
}

// ---- Registry ---------------------------------------------------------------

interface PackSeedConfig {
  /**
   * vertical_type stamped onto seeded estimate templates. The DB column is
   * free-text (no CHECK), so the new trades ('roofing', 'gc_remodel',
   * 'landscaping', 'concrete', 'other') can persist here even though the
   * narrower `VerticalType` TS union only knows hvac/plumbing/electrical/
   * painting — the `as VerticalType` casts bridge the repo interface.
   */
  verticalType: VerticalType;
  catalogSeeds: () => CatalogSeed[];
  templateSeeds: () => EstimateTemplateSeed[];
}

/** Resolve the seed config for a pack id, binding the free-text trade
 * label for the generic 'other' seeds. */
function packSeedConfig(packId: string, tradeLabel: string): PackSeedConfig | undefined {
  const base: Record<string, PackSeedConfig> = {
    hvac: { verticalType: 'hvac', catalogSeeds: hvacCatalogSeeds, templateSeeds: hvacTemplateSeeds },
    plumbing: { verticalType: 'plumbing', catalogSeeds: plumbingCatalogSeeds, templateSeeds: plumbingTemplateSeeds },
    electrical: { verticalType: 'electrical', catalogSeeds: electricalCatalogSeeds, templateSeeds: electricalTemplateSeeds },
    roofing: { verticalType: 'roofing' as VerticalType, catalogSeeds: roofingCatalogSeeds, templateSeeds: roofingTemplateSeeds },
    painting: { verticalType: 'painting', catalogSeeds: paintingCatalogSeeds, templateSeeds: paintingTemplateSeeds },
    gc_remodel: { verticalType: 'gc_remodel' as VerticalType, catalogSeeds: gcRemodelCatalogSeeds, templateSeeds: gcRemodelTemplateSeeds },
    landscaping: { verticalType: 'landscaping' as VerticalType, catalogSeeds: landscapingCatalogSeeds, templateSeeds: landscapingTemplateSeeds },
    concrete: { verticalType: 'concrete' as VerticalType, catalogSeeds: concreteCatalogSeeds, templateSeeds: concreteTemplateSeeds },
    other: {
      verticalType: 'other' as VerticalType,
      catalogSeeds: () => genericCatalogSeeds(tradeLabel),
      templateSeeds: () => genericTemplateSeeds(tradeLabel),
    },
  };
  return base[packId];
}

export function isSeedablePackId(packId: string): boolean {
  return packSeedConfig(packId, '') !== undefined;
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
  const tradeLabel = input.tradeLabel ?? '';
  const actorId = input.actorId ?? 'system';
  const config = packSeedConfig(packId, tradeLabel);

  if (!config) {
    return {
      packId,
      catalogItemsCreated: 0,
      templatesCreated: 0,
      alreadySeeded: false,
    };
  }

  // Per-seed idempotency: we seed each catalog item and each template
  // independently, skipping any whose name already exists. A previous
  // version of this code probed "does ANY of our seed names appear in
  // the existing templates" and bailed the whole pack if true — but
  // that meant a tenant who happened to have a manually-created
  // template named "Seasonal Tune-Up" or "Drain Cleaning" got the pack
  // skipped wholesale, leaving an empty price book + missing job types.
  // Per-seed checks recover the missing rows without overwriting the
  // operator's manual entries.
  const templateSeeds = config.templateSeeds();
  const existingTemplates = await deps.templateRepo.findByVertical(
    tenantId,
    config.verticalType,
  );
  const existingTemplateNames = new Set(
    existingTemplates.map((t) => t.name.toLowerCase()),
  );

  // Seed catalog items. Idempotency-check each by name (case-insensitive)
  // so an admin's pre-populated price book is never overwritten.
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

  // Seed estimate templates (job types). Per-seed name check matches the
  // catalog-side behavior above.
  let templatesCreated = 0;
  const seedDate = new Date();
  for (const seed of templateSeeds) {
    if (existingTemplateNames.has(seed.name.toLowerCase())) {
      continue;
    }
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
    // Reflects whether nothing new needed to be inserted — true when
    // every seed name was already present (so the pack was fully
    // covered). Distinct from the prior wholesale "any match" check
    // which falsely reported alreadySeeded on a single overlapping
    // template name and then skipped every other row.
    alreadySeeded: catalogItemsCreated === 0 && templatesCreated === 0,
  };
}
