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
// no vertical pack at all yet; the specs below are sensible standalone
// defaults following the hvac/plumbing structure (labor, visit fee,
// emergency, trip charge + specialty items / job types).
//
// Every new trade follows the same seed SHAPE, so the specs are pure data
// and the two builders below (tradeCatalogSeeds / tradeTemplateSeeds) do
// all the construction. Only hvac/plumbing keep bespoke seed functions.

interface TradeTemplateLine {
  description: string;
  cents: number;
  quantity?: number;
}

interface TradeTemplate {
  categoryId: string;
  name: string;
  description: string;
  customerMessage: string;
  lines: TradeTemplateLine[];
}

interface TradePackSpec {
  verticalType: VerticalType;
  /** Capitalized trade name, prefixed onto the generated seeds ('Electrical Labor'). */
  trade: string;
  laborDesc: string;
  visitName: string;
  visitDesc: string;
  tripDesc: string;
  prices: { labor: number; visit: number; emergency: number; trip: number };
  /** Specialty catalog items beyond the four standard ones. */
  extras: { name: string; description: string; cents: number }[];
  templates: TradeTemplate[];
}

function tradeCatalogSeeds(spec: TradePackSpec): CatalogSeed[] {
  return [
    { name: `${spec.trade} Labor`, description: spec.laborDesc, category: 'Labor', unit: 'hour', unitPriceCents: spec.prices.labor },
    { name: spec.visitName, description: spec.visitDesc, category: 'Labor', unit: 'each', unitPriceCents: spec.prices.visit },
    { name: `${spec.trade} Emergency Call Fee`, description: 'After-hours / same-day emergency dispatch fee.', category: 'Labor', unit: 'each', unitPriceCents: spec.prices.emergency },
    { name: `${spec.trade} Trip Charge`, description: spec.tripDesc, category: 'Labor', unit: 'each', unitPriceCents: spec.prices.trip },
    ...spec.extras.map((e): CatalogSeed => ({ name: e.name, description: e.description, category: 'Labor', unit: 'each', unitPriceCents: e.cents })),
  ];
}

function tradeTemplateSeeds(spec: TradePackSpec): EstimateTemplateSeed[] {
  return spec.templates.map((t) => ({
    categoryId: t.categoryId,
    name: t.name,
    description: t.description,
    customerMessage: t.customerMessage,
    lineItems: t.lines.map((l, i): LineItemTemplate => ({
      description: l.description,
      category: 'labor',
      defaultQuantity: l.quantity ?? 1,
      defaultUnitPriceCents: l.cents,
      taxable: false,
      sortOrder: i + 1,
      isOptional: false,
    })),
  }));
}

function tradePackConfig(spec: TradePackSpec): PackSeedConfig {
  return {
    verticalType: spec.verticalType,
    catalogSeeds: () => tradeCatalogSeeds(spec),
    templateSeeds: () => tradeTemplateSeeds(spec),
  };
}

const ELECTRICAL_PRICES = { labor: 13500, visit: 8900, emergency: 17500, trip: 4900, panel: 24900, fixture: 11900 };

const ELECTRICAL_PACK: TradePackSpec = {
  verticalType: 'electrical',
  trade: 'Electrical',
  laborDesc: 'Standard electrician hourly labor.',
  visitName: 'Electrical Diagnostic Fee',
  visitDesc: 'Trip + diagnostic to trace the issue on site.',
  tripDesc: 'Standard truck roll fee.',
  prices: ELECTRICAL_PRICES,
  extras: [
    { name: 'Panel Upgrade', description: 'Panel / breaker panel upgrade, standard residential.', cents: ELECTRICAL_PRICES.panel },
    { name: 'Fixture / Ceiling Fan Install', description: 'Install a customer-supplied fixture or ceiling fan.', cents: ELECTRICAL_PRICES.fixture },
  ],
  templates: [
    { categoryId: 'electrical-diagnostic', name: 'Electrical Diagnostic Visit', description: 'On-site diagnostic to trace an electrical issue.', customerMessage: "Thanks for choosing us. Our electrician will trace the issue, walk you through what's needed, and quote any work before we begin.", lines: [{ description: 'Diagnostic + trip fee', cents: ELECTRICAL_PRICES.visit }] },
    { categoryId: 'electrical-repair', name: 'Troubleshooting & Repair', description: 'Diagnostic + 1 hour of repair labor for a typical issue.', customerMessage: "Here's the estimate for the repair. The diagnostic fee is included — you only pay for the repair time and any parts.", lines: [{ description: 'Diagnostic + trip fee', cents: ELECTRICAL_PRICES.visit }, { description: 'Repair labor', cents: ELECTRICAL_PRICES.labor }] },
    { categoryId: 'electrical-panel', name: 'Panel Upgrade', description: 'Residential breaker panel upgrade.', customerMessage: "Here's the estimate for your panel upgrade. We'll handle permits and coordinate the power-company shutoff.", lines: [{ description: 'Panel upgrade', cents: ELECTRICAL_PRICES.panel }] },
    { categoryId: 'electrical-lighting', name: 'Fixture / Ceiling Fan Install', description: 'Install a customer-supplied fixture or ceiling fan.', customerMessage: "Here's the estimate to install your fixture. If the box needs bracing for a fan, we'll let you know before we start.", lines: [{ description: 'Fixture install', cents: ELECTRICAL_PRICES.fixture }] },
    { categoryId: 'electrical-emergency', name: 'After-Hours Emergency Electrical', description: 'Emergency dispatch for outages / sparking / safety hazards.', customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.", lines: [{ description: 'Emergency dispatch fee', cents: ELECTRICAL_PRICES.emergency }] },
  ],
};

const PAINTING_PRICES = { labor: 8500, visit: 7500, emergency: 15000, trip: 3900, interior: 24900, exterior: 49900 };

const PAINTING_PACK: TradePackSpec = {
  verticalType: 'painting',
  trade: 'Painting',
  laborDesc: 'Standard painter hourly labor.',
  visitName: 'Painting Estimate Fee',
  visitDesc: 'On-site walk-through, measurements, and written estimate.',
  tripDesc: 'Standard trip fee.',
  prices: PAINTING_PRICES,
  extras: [
    { name: 'Interior Room Paint', description: 'Walls + ceiling for a standard room, paint not included.', cents: PAINTING_PRICES.interior },
    { name: 'Exterior Paint Package', description: 'Exterior repaint package for a typical single-story home.', cents: PAINTING_PRICES.exterior },
  ],
  templates: [
    { categoryId: 'painting-diagnostic', name: 'Estimate Walk-Through', description: 'On-site walk-through, measurements, and written estimate.', customerMessage: "Thanks for having us out. Here's the written estimate based on the walk-through — no obligation.", lines: [{ description: 'Estimate walk-through', cents: PAINTING_PRICES.visit }] },
    { categoryId: 'painting-interior', name: 'Interior Room Paint', description: 'Walls + ceiling for a standard room, two coats.', customerMessage: "Here's the estimate for the room. We move and cover furniture, prep every surface, and leave it spotless.", lines: [{ description: 'Interior room paint (labor)', cents: PAINTING_PRICES.interior }] },
    { categoryId: 'painting-exterior', name: 'Exterior Paint', description: 'Exterior repaint for a typical single-story home.', customerMessage: "Here's the estimate for the exterior. Includes pressure washing, prep, and two coats.", lines: [{ description: 'Exterior paint package (labor)', cents: PAINTING_PRICES.exterior }] },
    { categoryId: 'painting-prep', name: 'Surface Prep & Repair', description: 'Patching, sanding, and caulking ahead of paint.', customerMessage: "Good paint starts with prep. Here's the estimate for getting the surfaces ready.", lines: [{ description: 'Prep labor', cents: PAINTING_PRICES.labor, quantity: 2 }] },
    { categoryId: 'painting-finishing', name: 'Touch-Up & Finish', description: 'Small touch-ups and finish work.', customerMessage: "Here's the estimate for the touch-up work.", lines: [{ description: 'Touch-up labor', cents: PAINTING_PRICES.labor }] },
  ],
};

const ROOFING_PRICES = { labor: 12000, visit: 9900, emergency: 25000, trip: 4900, leak: 34900, gutter: 19900 };

const ROOFING_PACK: TradePackSpec = {
  verticalType: 'roofing' as VerticalType,
  trade: 'Roofing',
  laborDesc: 'Standard roofing crew hourly labor.',
  visitName: 'Roof Inspection Fee',
  visitDesc: 'On-site roof inspection with written findings.',
  tripDesc: 'Standard truck roll fee.',
  prices: ROOFING_PRICES,
  extras: [
    { name: 'Leak Repair', description: 'Locate and repair a single roof leak.', cents: ROOFING_PRICES.leak },
    { name: 'Gutter Repair', description: 'Repair a section of gutter / downspout.', cents: ROOFING_PRICES.gutter },
  ],
  templates: [
    { categoryId: 'roofing-inspection', name: 'Roof Inspection', description: 'On-site roof inspection with photos and written findings.', customerMessage: "We'll walk the roof, photograph everything we find, and send you a written report with options.", lines: [{ description: 'Roof inspection', cents: ROOFING_PRICES.visit }] },
    { categoryId: 'roofing-repair', name: 'Leak Repair', description: 'Locate and repair a single roof leak.', customerMessage: "Here's the estimate to stop the leak. We find the source — not just the stain — and warranty the repair.", lines: [{ description: 'Leak repair', cents: ROOFING_PRICES.leak }] },
    { categoryId: 'roofing-replacement', name: 'Shingle Replacement', description: 'Tear-off and replacement estimate for a typical roof.', customerMessage: "Here's the estimate for the replacement. Includes tear-off, decking check, underlayment, and cleanup.", lines: [{ description: 'Replacement labor', cents: ROOFING_PRICES.labor, quantity: 8 }] },
    { categoryId: 'roofing-emergency', name: 'Storm Damage Response', description: 'Emergency dispatch for storm damage / active leaks.', customerMessage: "We're on the way. We'll tarp it to stop the water first, then walk you through the repair options.", lines: [{ description: 'Emergency dispatch fee', cents: ROOFING_PRICES.emergency }] },
    { categoryId: 'roofing-gutters', name: 'Gutter Repair', description: 'Repair a section of gutter / downspout.', customerMessage: "Here's the estimate for the gutter repair.", lines: [{ description: 'Gutter repair', cents: ROOFING_PRICES.gutter }] },
  ],
};

const GC_REMODEL_PRICES = { labor: 15000, visit: 14900, emergency: 20000, trip: 4900, day: 96000, punch: 24900 };

const GC_REMODEL_PACK: TradePackSpec = {
  verticalType: 'gc_remodel' as VerticalType,
  trade: 'GC',
  laborDesc: 'General contracting hourly labor.',
  visitName: 'Site Consultation Fee',
  visitDesc: 'On-site consultation with written scope.',
  tripDesc: 'Standard truck roll fee.',
  prices: GC_REMODEL_PRICES,
  extras: [
    { name: 'Punch List / Small Repair', description: 'Small repairs and punch-list items, flat rate.', cents: GC_REMODEL_PRICES.punch },
    { name: 'Project Day Rate', description: 'Full crew day rate for a single project day.', cents: GC_REMODEL_PRICES.day },
  ],
  templates: [
    { categoryId: 'gc-consult', name: 'Site Consultation', description: 'On-site consultation with written scope and budget range.', customerMessage: "Thanks for having us out. Here's the scope and budget range from the consultation — no obligation.", lines: [{ description: 'Site consultation', cents: GC_REMODEL_PRICES.visit }] },
    { categoryId: 'gc-kitchen', name: 'Kitchen Remodel', description: 'Kitchen remodel estimate template — scope per consultation.', customerMessage: "Here's the estimate for the kitchen remodel based on our walk-through. Every line item is adjustable.", lines: [{ description: 'Remodel labor (per day)', cents: GC_REMODEL_PRICES.day, quantity: 5 }] },
    { categoryId: 'gc-bathroom', name: 'Bathroom Remodel', description: 'Bathroom remodel estimate template — scope per consultation.', customerMessage: "Here's the estimate for the bathroom remodel based on our walk-through. Every line item is adjustable.", lines: [{ description: 'Remodel labor (per day)', cents: GC_REMODEL_PRICES.day, quantity: 3 }] },
    { categoryId: 'gc-repair', name: 'Punch List / Small Repair', description: 'Small repairs and punch-list items, flat rate.', customerMessage: "Here's the flat-rate estimate for the punch list.", lines: [{ description: 'Punch list / small repair', cents: GC_REMODEL_PRICES.punch }] },
    { categoryId: 'gc-emergency', name: 'Emergency Response', description: 'Emergency dispatch for storm / water / structural calls.', customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour on site. Any repair work will be quoted before we proceed.", lines: [{ description: 'Emergency dispatch fee', cents: GC_REMODEL_PRICES.emergency }] },
  ],
};

const LANDSCAPING_PRICES = { labor: 7500, visit: 4900, emergency: 15000, trip: 3900, lawn: 9900, irrigation: 14900 };

const LANDSCAPING_PACK: TradePackSpec = {
  verticalType: 'landscaping' as VerticalType,
  trade: 'Landscaping',
  laborDesc: 'Standard landscaping crew hourly labor.',
  visitName: 'Site Assessment Fee',
  visitDesc: 'On-site assessment with written recommendations.',
  tripDesc: 'Standard truck roll fee.',
  prices: LANDSCAPING_PRICES,
  extras: [
    { name: 'Lawn Care Visit', description: 'Mow, edge, and blow for a typical residential yard.', cents: LANDSCAPING_PRICES.lawn },
    { name: 'Irrigation Repair', description: 'Diagnose and repair a sprinkler / irrigation zone.', cents: LANDSCAPING_PRICES.irrigation },
  ],
  templates: [
    { categoryId: 'landscape-cleanup', name: 'Yard Cleanup', description: 'One-time yard cleanup for a typical residential yard.', customerMessage: "Here's the estimate for the cleanup. We haul everything away and leave it looking right.", lines: [{ description: 'Cleanup labor', cents: LANDSCAPING_PRICES.labor, quantity: 4 }] },
    { categoryId: 'landscape-maintenance', name: 'Lawn Care Visit', description: 'Mow, edge, and blow for a typical residential yard.', customerMessage: "Here's the per-visit price for lawn care. Ask about the seasonal plan for a standing schedule.", lines: [{ description: 'Lawn care visit', cents: LANDSCAPING_PRICES.lawn }] },
    { categoryId: 'landscape-install', name: 'Planting / Bed Install', description: 'New plantings and bed installation.', customerMessage: "Here's the estimate for the planting work. Plants are priced per the selection you approve.", lines: [{ description: 'Planting labor', cents: LANDSCAPING_PRICES.labor, quantity: 3 }] },
    { categoryId: 'landscape-irrigation', name: 'Irrigation Repair', description: 'Diagnose and repair a sprinkler / irrigation zone.', customerMessage: "Here's the estimate for the irrigation repair. The assessment fee is included.", lines: [{ description: 'Irrigation repair', cents: LANDSCAPING_PRICES.irrigation }] },
    { categoryId: 'landscape-emergency', name: 'Storm Cleanup', description: 'Emergency dispatch for storm debris / downed limbs.', customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of cleanup.", lines: [{ description: 'Emergency dispatch fee', cents: LANDSCAPING_PRICES.emergency }] },
  ],
};

const CONCRETE_PRICES = { labor: 11000, visit: 9900, emergency: 20000, trip: 4900, slab: 59900, removal: 24900 };

const CONCRETE_PACK: TradePackSpec = {
  verticalType: 'concrete' as VerticalType,
  trade: 'Concrete',
  laborDesc: 'Standard concrete crew hourly labor.',
  visitName: 'Site Visit / Measurement Fee',
  visitDesc: 'On-site visit, measurements, and written estimate.',
  tripDesc: 'Standard truck roll fee.',
  prices: CONCRETE_PRICES,
  extras: [
    { name: 'Slab Pour', description: 'Standard concrete slab pour, form and finish.', cents: CONCRETE_PRICES.slab },
    { name: 'Concrete Removal', description: 'Break out and haul away existing concrete.', cents: CONCRETE_PRICES.removal },
  ],
  templates: [
    { categoryId: 'concrete-estimate', name: 'Site Visit / Measurement', description: 'On-site visit, measurements, and written estimate.', customerMessage: "Thanks for having us out. Here's the written estimate based on the measurements — no obligation.", lines: [{ description: 'Site visit / measurement', cents: CONCRETE_PRICES.visit }] },
    { categoryId: 'concrete-pour', name: 'Slab / Driveway Pour', description: 'Standard concrete pour — form, pour, and finish.', customerMessage: "Here's the estimate for the pour. Includes forming, finishing, and cleanup.", lines: [{ description: 'Concrete pour', cents: CONCRETE_PRICES.slab }] },
    { categoryId: 'concrete-repair', name: 'Crack & Surface Repair', description: 'Repair cracks and spalling on existing concrete.', customerMessage: "Here's the estimate for the repair work.", lines: [{ description: 'Repair labor', cents: CONCRETE_PRICES.labor, quantity: 2 }] },
    { categoryId: 'concrete-removal', name: 'Concrete Removal', description: 'Break out and haul away existing concrete.', customerMessage: "Here's the estimate for the removal. We haul everything and leave the site clean.", lines: [{ description: 'Concrete removal', cents: CONCRETE_PRICES.removal }] },
    { categoryId: 'concrete-emergency', name: 'Emergency Service', description: 'Emergency dispatch for trip hazards / structural cracks.', customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour on site. Any repair work will be quoted before we proceed.", lines: [{ description: 'Emergency dispatch fee', cents: CONCRETE_PRICES.emergency }] },
  ],
};

// 'other' — generic safe defaults so a trade with no dedicated pack still
// lands on a usable price book and job types. When the operator typed a
// free-text label (tradeLabel), seed names carry it; otherwise they're
// plainly "General …" and editable.
function genericPackSpec(tradeLabel: string): TradePackSpec {
  const p = tradeLabel.trim() || 'General';
  const prices = { labor: 10000, visit: 8900, emergency: 15000, trip: 4900 };
  return {
    verticalType: 'other' as VerticalType,
    trade: p,
    laborDesc: 'Standard hourly labor.',
    visitName: `${p} Diagnostic Fee`,
    visitDesc: 'Trip + diagnostic to assess the job on site.',
    tripDesc: 'Standard truck roll fee.',
    prices,
    extras: [],
    templates: [
      { categoryId: 'general-diagnostic', name: `${p} Service Visit`, description: 'On-site visit to assess the job and provide an estimate.', customerMessage: "Thanks for choosing us. We'll assess the job on site and quote any work before we begin.", lines: [{ description: 'Diagnostic + trip fee', cents: prices.visit }] },
      { categoryId: 'general-repair', name: `${p} Repair`, description: 'Diagnostic + 1 hour of repair labor for a typical job.', customerMessage: "Here's the estimate for the repair. The diagnostic fee is included — you only pay for the repair time and any parts.", lines: [{ description: 'Diagnostic + trip fee', cents: prices.visit }, { description: 'Repair labor', cents: prices.labor }] },
      { categoryId: 'general-install', name: `${p} Installation`, description: 'Standard installation, 2 hours of labor.', customerMessage: "Here's the estimate for the installation.", lines: [{ description: 'Installation labor', cents: prices.labor, quantity: 2 }] },
      { categoryId: 'general-maintenance', name: `${p} Maintenance Visit`, description: 'Scheduled maintenance visit, 1 hour of labor.', customerMessage: "Here's the estimate for the maintenance visit.", lines: [{ description: 'Maintenance labor', cents: prices.labor }] },
      { categoryId: 'general-emergency', name: `${p} After-Hours Emergency`, description: 'Emergency dispatch.', customerMessage: "We're on the way. Emergency dispatch covers travel + the first hour of diagnostic. Any repair work will be quoted before we proceed.", lines: [{ description: 'Emergency dispatch fee', cents: prices.emergency }] },
    ],
  };
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

const PACK_SEEDS: Record<string, PackSeedConfig> = {
  hvac: { verticalType: 'hvac', catalogSeeds: hvacCatalogSeeds, templateSeeds: hvacTemplateSeeds },
  plumbing: { verticalType: 'plumbing', catalogSeeds: plumbingCatalogSeeds, templateSeeds: plumbingTemplateSeeds },
  electrical: tradePackConfig(ELECTRICAL_PACK),
  painting: tradePackConfig(PAINTING_PACK),
  roofing: tradePackConfig(ROOFING_PACK),
  gc_remodel: tradePackConfig(GC_REMODEL_PACK),
  landscaping: tradePackConfig(LANDSCAPING_PACK),
  concrete: tradePackConfig(CONCRETE_PACK),
};

/** Resolve the seed config for a pack id, binding the free-text trade
 * label for the generic 'other' seeds. */
function packSeedConfig(packId: string, tradeLabel: string): PackSeedConfig | undefined {
  if (packId === 'other') {
    return tradePackConfig(genericPackSpec(tradeLabel));
  }
  return PACK_SEEDS[packId];
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
