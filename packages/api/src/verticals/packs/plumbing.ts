// P4-003A/003B: Plumbing Vertical Pack — Taxonomy and Terminology

import {
  VerticalPack,
  ServiceCategory,
  TerminologyMap,
  createVerticalPack,
} from '../registry';

const PLUMBING_CATEGORIES: ServiceCategory[] = [
  // Top-level categories
  { id: 'plumb-install', name: 'Installation', sortOrder: 1 },
  { id: 'plumb-repair', name: 'Repair', sortOrder: 2 },
  { id: 'plumb-maintenance', name: 'Maintenance', sortOrder: 3 },
  { id: 'plumb-diagnostic', name: 'Diagnostic', sortOrder: 4 },
  { id: 'plumb-emergency', name: 'Emergency Service', sortOrder: 5 },

  // Installation subcategories
  { id: 'plumb-install-waterheater', name: 'Water Heater Installation', parentId: 'plumb-install', sortOrder: 1 },
  { id: 'plumb-install-fixture', name: 'Fixture Installation', parentId: 'plumb-install', sortOrder: 2 },
  { id: 'plumb-install-disposal', name: 'Garbage Disposal Installation', parentId: 'plumb-install', sortOrder: 3 },
  { id: 'plumb-install-softener', name: 'Water Softener Installation', parentId: 'plumb-install', sortOrder: 4 },
  { id: 'plumb-install-repipe', name: 'Repiping', parentId: 'plumb-install', sortOrder: 5 },
  { id: 'plumb-install-sump', name: 'Sump Pump Installation', parentId: 'plumb-install', sortOrder: 6 },

  // Repair subcategories
  { id: 'plumb-repair-leak', name: 'Leak Repair', parentId: 'plumb-repair', sortOrder: 1 },
  { id: 'plumb-repair-drain', name: 'Drain Clearing', parentId: 'plumb-repair', sortOrder: 2 },
  { id: 'plumb-repair-toilet', name: 'Toilet Repair', parentId: 'plumb-repair', sortOrder: 3 },
  { id: 'plumb-repair-faucet', name: 'Faucet Repair', parentId: 'plumb-repair', sortOrder: 4 },
  { id: 'plumb-repair-waterheater', name: 'Water Heater Repair', parentId: 'plumb-repair', sortOrder: 5 },
  { id: 'plumb-repair-sewer', name: 'Sewer Line Repair', parentId: 'plumb-repair', sortOrder: 6 },
  { id: 'plumb-repair-pipe-burst', name: 'Burst Pipe Repair', parentId: 'plumb-repair', sortOrder: 7 },

  // Maintenance subcategories
  { id: 'plumb-maint-drain-clean', name: 'Drain Cleaning', parentId: 'plumb-maintenance', sortOrder: 1 },
  { id: 'plumb-maint-waterheater', name: 'Water Heater Flush', parentId: 'plumb-maintenance', sortOrder: 2 },
  { id: 'plumb-maint-inspection', name: 'Plumbing Inspection', parentId: 'plumb-maintenance', sortOrder: 3 },
  { id: 'plumb-maint-backflow', name: 'Backflow Testing', parentId: 'plumb-maintenance', sortOrder: 4 },
];

const PLUMBING_TERMINOLOGY: TerminologyMap = {
  'water_heater': {
    displayName: 'Water Heater',
    aliases: ['hot water heater', 'hwh', 'water heater unit'],
  },
  'water_heater_tank': {
    displayName: 'Tank Water Heater',
    aliases: ['tank water heater', 'storage water heater', 'standard water heater'],
  },
  'water_heater_tankless': {
    displayName: 'Tankless Water Heater',
    aliases: ['tankless', 'on-demand', 'instant water heater', 'on demand water heater'],
  },
  'garbage_disposal': {
    displayName: 'Garbage Disposal',
    aliases: ['disposal', 'disposer', 'insinkerator', 'garbage disposer'],
  },
  'sump_pump': {
    displayName: 'Sump Pump',
    aliases: ['sump', 'basement pump', 'ejector pump'],
  },
  'water_softener': {
    displayName: 'Water Softener',
    aliases: ['softener', 'water conditioner', 'water treatment'],
  },
  'backflow_preventer': {
    displayName: 'Backflow Preventer',
    aliases: ['backflow', 'backflow valve', 'rpz', 'reduced pressure zone'],
  },
  'shut_off_valve': {
    displayName: 'Shut-Off Valve',
    aliases: ['shutoff', 'shut off', 'stop valve', 'isolation valve', 'main shutoff'],
  },
  'prv': {
    displayName: 'Pressure Reducing Valve',
    aliases: ['pressure regulator', 'pressure valve', 'prv', 'water pressure regulator'],
  },
  'p_trap': {
    displayName: 'P-Trap',
    aliases: ['trap', 'drain trap', 'sink trap', 'p trap'],
  },
  'flange': {
    displayName: 'Flange',
    aliases: ['toilet flange', 'closet flange', 'wax ring flange'],
  },
  'wax_ring': {
    displayName: 'Wax Ring',
    aliases: ['wax seal', 'toilet seal', 'toilet wax ring'],
  },
  'anode_rod': {
    displayName: 'Anode Rod',
    aliases: ['anode', 'sacrificial anode', 'water heater rod'],
    description: 'Sacrificial rod that prevents tank corrosion — should be replaced every 3-5 years',
  },
  'pex': {
    displayName: 'PEX Piping',
    aliases: ['pex', 'pex-a', 'pex-b', 'crosslinked polyethylene'],
    description: 'Flexible piping material commonly used for water supply lines',
  },
  'copper': {
    displayName: 'Copper Piping',
    aliases: ['copper pipe', 'copper line', 'type m copper', 'type l copper'],
  },
  'sewer_line': {
    displayName: 'Sewer Line',
    aliases: ['sewer', 'main line', 'sewer main', 'drain line', 'main drain'],
  },
  'cleanout': {
    displayName: 'Cleanout',
    aliases: ['cleanout access', 'sewer cleanout', 'drain cleanout'],
  },
  'snake': {
    displayName: 'Drain Snake',
    aliases: ['auger', 'drain auger', 'plumber snake', 'cable machine'],
  },
  'hydrojetting': {
    displayName: 'Hydro Jetting',
    aliases: ['hydro jet', 'jetting', 'water jetting', 'high pressure cleaning'],
    description: 'High-pressure water cleaning for drain and sewer lines',
  },
};

export function createPlumbingPack(): VerticalPack {
  return createVerticalPack(
    'plumbing',
    'Plumbing Professional',
    '1.0.0',
    'Plumbing service pack for residential and light commercial',
    PLUMBING_CATEGORIES,
    PLUMBING_TERMINOLOGY
  );
}

export const PLUMBING_LINE_ITEM_DEFAULTS = {
  laborRatePerHourCents: 11500, // $115/hr
  diagnosticFeeCents: 7500, // $75
  emergencyCallFeeCents: 17500, // $175
  tripChargeCents: 4900, // $49
  drainCleaningCents: 14900, // $149
  cameraInspectionCents: 19900, // $199
};
