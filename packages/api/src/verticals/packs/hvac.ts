// P4-002A/002B: HVAC Vertical Pack — Taxonomy and Terminology

import {
  VerticalPack,
  ServiceCategory,
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

export function createHvacPack(): VerticalPack {
  return createVerticalPack(
    'hvac',
    'HVAC Professional',
    '1.0.0',
    'Heating, ventilation, and air conditioning service pack for residential and light commercial',
    HVAC_CATEGORIES,
    HVAC_TERMINOLOGY
  );
}

export const HVAC_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 12500, // $125/hr
  diagnosticFeeCents: 8900, // $89
  emergencyCallFeeCents: 15000, // $150
  tripChargeCents: 4900, // $49
  seasonalTuneUpCents: 9900, // $99
  filterReplacementCents: 2500, // $25
};
