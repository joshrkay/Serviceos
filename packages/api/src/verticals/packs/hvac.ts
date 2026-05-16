// P4-002A/002B: HVAC Vertical Pack — Taxonomy and Terminology

import {
  VerticalPack,
  ServiceCategory,
  IntakeQuestion,
  ObjectionScript,
  TerminologyMap,
  createVerticalPack,
} from '../registry';

const HVAC_CATEGORIES: ServiceCategory[] = [
  // Top-level categories
  { id: 'hvac-install', name: 'Installation', sortOrder: 1 },
  { id: 'hvac-repair', name: 'Repair', sortOrder: 2 },
  { id: 'hvac-maintenance', name: 'Maintenance', sortOrder: 3 },
  { id: 'hvac-diagnostic', name: 'Diagnostic', sortOrder: 4 },
  { id: 'hvac-emergency', name: 'Emergency Service', sortOrder: 5 },

  // Installation subcategories
  { id: 'hvac-install-ac', name: 'AC Installation', parentId: 'hvac-install', sortOrder: 1 },
  { id: 'hvac-install-furnace', name: 'Furnace Installation', parentId: 'hvac-install', sortOrder: 2 },
  { id: 'hvac-install-heatpump', name: 'Heat Pump Installation', parentId: 'hvac-install', sortOrder: 3 },
  { id: 'hvac-install-ductwork', name: 'Ductwork Installation', parentId: 'hvac-install', sortOrder: 4 },
  { id: 'hvac-install-thermostat', name: 'Thermostat Installation', parentId: 'hvac-install', sortOrder: 5 },
  { id: 'hvac-install-minisplit', name: 'Mini-Split Installation', parentId: 'hvac-install', sortOrder: 6 },

  // Repair subcategories
  { id: 'hvac-repair-ac', name: 'AC Repair', parentId: 'hvac-repair', sortOrder: 1 },
  { id: 'hvac-repair-furnace', name: 'Furnace Repair', parentId: 'hvac-repair', sortOrder: 2 },
  { id: 'hvac-repair-heatpump', name: 'Heat Pump Repair', parentId: 'hvac-repair', sortOrder: 3 },
  { id: 'hvac-repair-ductwork', name: 'Ductwork Repair', parentId: 'hvac-repair', sortOrder: 4 },
  { id: 'hvac-repair-refrigerant', name: 'Refrigerant Leak Repair', parentId: 'hvac-repair', sortOrder: 5 },
  { id: 'hvac-repair-electrical', name: 'Electrical Component Repair', parentId: 'hvac-repair', sortOrder: 6 },

  // Maintenance subcategories
  { id: 'hvac-maint-tuneup', name: 'Seasonal Tune-Up', parentId: 'hvac-maintenance', sortOrder: 1 },
  { id: 'hvac-maint-filter', name: 'Filter Replacement', parentId: 'hvac-maintenance', sortOrder: 2 },
  { id: 'hvac-maint-duct-clean', name: 'Duct Cleaning', parentId: 'hvac-maintenance', sortOrder: 3 },
  { id: 'hvac-maint-coil-clean', name: 'Coil Cleaning', parentId: 'hvac-maintenance', sortOrder: 4 },
  { id: 'hvac-maint-inspection', name: 'System Inspection', parentId: 'hvac-maintenance', sortOrder: 5 },
];

const HVAC_TERMINOLOGY: TerminologyMap = {
  'ac': {
    displayName: 'Air Conditioner',
    aliases: ['air conditioner', 'a/c', 'air conditioning', 'cooling unit', 'central air'],
  },
  'furnace': {
    displayName: 'Furnace',
    aliases: ['heater', 'heating unit', 'gas furnace', 'electric furnace'],
  },
  'heat_pump': {
    displayName: 'Heat Pump',
    aliases: ['heat pump', 'heatpump', 'hp'],
  },
  'mini_split': {
    displayName: 'Mini-Split System',
    aliases: ['mini split', 'minisplit', 'ductless', 'ductless mini split', 'wall unit'],
  },
  'thermostat': {
    displayName: 'Thermostat',
    aliases: ['tstat', 'temp control', 'temperature control', 'smart thermostat', 'programmable thermostat'],
  },
  'compressor': {
    displayName: 'Compressor',
    aliases: ['ac compressor', 'outdoor unit compressor'],
  },
  'condenser': {
    displayName: 'Condenser',
    aliases: ['outdoor unit', 'condenser unit', 'outside unit'],
  },
  'evaporator': {
    displayName: 'Evaporator Coil',
    aliases: ['evap coil', 'indoor coil', 'a-coil', 'evaporator'],
  },
  'refrigerant': {
    displayName: 'Refrigerant',
    aliases: ['freon', 'coolant', 'r410a', 'r-410a', 'r22', 'r-22'],
  },
  'blower_motor': {
    displayName: 'Blower Motor',
    aliases: ['fan motor', 'blower', 'indoor fan motor'],
  },
  'capacitor': {
    displayName: 'Capacitor',
    aliases: ['start capacitor', 'run capacitor', 'cap'],
  },
  'contactor': {
    displayName: 'Contactor',
    aliases: ['relay', 'ac contactor'],
  },
  'ductwork': {
    displayName: 'Ductwork',
    aliases: ['ducts', 'air ducts', 'duct system', 'supply ducts', 'return ducts'],
  },
  'seer': {
    displayName: 'SEER Rating',
    aliases: ['seer', 'seer2', 'seer rating', 'efficiency rating'],
    description: 'Seasonal Energy Efficiency Ratio — measures cooling efficiency',
  },
  'tonnage': {
    displayName: 'Tonnage',
    aliases: ['ton', 'tons', 'btu capacity'],
    description: 'Unit of cooling capacity — 1 ton = 12,000 BTU/hr',
  },
  'heat_exchanger': {
    displayName: 'Heat Exchanger',
    aliases: ['exchanger', 'furnace heat exchanger'],
    description: 'Critical component that transfers heat in furnaces — cracks require immediate attention',
  },
  'expansion_valve': {
    displayName: 'Expansion Valve',
    aliases: ['txv', 'thermostatic expansion valve', 'metering device'],
  },
  'drain_line': {
    displayName: 'Condensate Drain Line',
    aliases: ['drain line', 'condensate line', 'ac drain'],
  },
};

/**
 * §3D — default disambiguation questions the calling agent uses when
 * intent classifier confidence is low or the caller's request is
 * vertical-ambiguous. Tenants can override via tenant settings.
 */
const HVAC_INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    trigger: 'hvac',
    question: 'Is this for heating or cooling?',
    intent: 'service_disambiguation',
  },
  {
    trigger: 'unknown_issue',
    question: 'Is this an emergency, or can we schedule a visit?',
    intent: 'urgency_triage',
  },
  {
    trigger: 'equipment_age',
    question: 'How old is the unit?',
    intent: 'equipment_age',
  },
  {
    trigger: 'symptom',
    question: 'Is the system not turning on, not reaching temperature, or making an unusual noise?',
    intent: 'symptom_triage',
  },
];

/**
 * §3E — default objection-handling reframes the calling agent uses
 * when the classifier flags an objection_detected signal. Tenants can
 * override individual entries via tenant settings; the `id` is the
 * override key. Defaults are starter copy meant to be tuned, not
 * pulled from any vendor or training corpus.
 */
const HVAC_OBJECTION_SCRIPTS: readonly ObjectionScript[] = [
  {
    id: 'price',
    patterns: ['too expensive', 'that\'s expensive', 'can\'t afford', 'pricey', 'cost too much'],
    reframe:
      'Our technicians carry common parts on the truck, so you typically won\'t pay for a second trip if a repair is needed.',
  },
  {
    id: 'dispatch_fee',
    patterns: ['dispatch fee', 'service call fee', 'why do I need to pay just to come out', 'trip charge'],
    reframe:
      'The diagnostic fee goes toward your repair if you proceed today — so it\'s not on top of the work, it\'s part of it.',
  },
  {
    id: 'phone_quote',
    patterns: ['just tell me over the phone', 'give me a quote on the phone', 'how much would it cost', 'ballpark price'],
    reframe:
      'Most heating and cooling issues need eyes on the system before we can give you an honest number — we don\'t want to guess wrong on something this important.',
  },
  {
    id: 'hesitation',
    patterns: ['I\'ll think about it', 'let me think on it', 'I need to talk to my spouse', 'call you back'],
    reframe:
      'Of course. Want me to hold a slot in case you decide to move forward, or call you back tomorrow morning?',
  },
];

const HVAC_TRAINING_ASSETS = [
  {
    assetKind: 'emergency_rule',
    title: 'No heat extreme weather escalation',
    scrubbedText:
      'If the caller has no heat during freezing weather, treat the call as urgent and escalate to the on-call dispatcher.',
    labels: {
      intent: 'emergency_dispatch',
      urgencyTier: 'emergency',
      expectedNextAction: 'escalate_to_oncall',
      shouldEscalate: true,
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
  {
    assetKind: 'eval_scenario',
    title: 'Heating versus cooling disambiguation',
    scrubbedText:
      'When a caller says the system is not working, ask whether the issue is heating, cooling, or airflow before scheduling.',
    labels: {
      expectedNextQuestion: 'Is this for heating, cooling, or airflow?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
];

export function createHvacPack(): VerticalPack {
  const pack = createVerticalPack(
    'hvac',
    'HVAC Professional',
    '1.0.0',
    'Heating, ventilation, and air conditioning service pack for residential and light commercial',
    HVAC_CATEGORIES,
    HVAC_TERMINOLOGY,
    HVAC_INTAKE_QUESTIONS,
    HVAC_OBJECTION_SCRIPTS
  );
  pack.metadata = {
    ...pack.metadata,
    training_tier: 'first_class',
    training_assets: HVAC_TRAINING_ASSETS,
  };
  return pack;
}

export const HVAC_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 12500, // $125/hr
  diagnosticFeeCents: 8900, // $89
  emergencyCallFeeCents: 15000, // $150
  tripChargeCents: 4900, // $49
  seasonalTuneUpCents: 9900, // $99
  filterReplacementCents: 2500, // $25
};
