import { TerminologyEntry, TerminologyMap } from '../hvac/terminology';

export { TerminologyEntry, TerminologyMap, validateTerminologyMap } from '../hvac/terminology';

export const PLUMBING_TERMINOLOGY: TerminologyMap = {
  // Equipment / Components
  pipe: {
    canonical: 'pipe',
    displayLabel: 'Pipe',
    promptHint: 'Water supply or drain pipe',
    aliases: ['piping', 'water line', 'supply line', 'drain pipe'],
  },
  fitting: {
    canonical: 'fitting',
    displayLabel: 'Fitting',
    promptHint: 'Pipe fitting or connector',
    aliases: ['connector', 'coupling', 'elbow', 'tee', 'adapter'],
  },
  valve: {
    canonical: 'valve',
    displayLabel: 'Valve',
    promptHint: 'Water shutoff or control valve',
    aliases: ['shutoff valve', 'gate valve', 'ball valve', 'check valve', 'shutoff'],
  },
  fixture: {
    canonical: 'fixture',
    displayLabel: 'Fixture',
    promptHint: 'Plumbing fixture (faucet, toilet, sink)',
    aliases: ['faucet', 'toilet', 'sink', 'tub', 'shower', 'bidet'],
  },
  drain: {
    canonical: 'drain',
    displayLabel: 'Drain',
    promptHint: 'Drain line or drain assembly',
    aliases: ['drain line', 'drain pipe', 'waste line', 'trap'],
  },
  sewer: {
    canonical: 'sewer',
    displayLabel: 'Sewer',
    promptHint: 'Sewer line or main sewer',
    aliases: ['sewer line', 'sewer main', 'main line', 'sewer pipe'],
  },
  water_heater: {
    canonical: 'water_heater',
    displayLabel: 'Water Heater',
    promptHint: 'Tank or tankless water heater',
    aliases: ['hot water heater', 'tank', 'tankless', 'water tank', 'boiler'],
  },
  sump_pump: {
    canonical: 'sump_pump',
    displayLabel: 'Sump Pump',
    promptHint: 'Basement sump pump system',
    aliases: ['sump', 'ejector pump', 'sewage pump'],
  },
  backflow_preventer: {
    canonical: 'backflow_preventer',
    displayLabel: 'Backflow Preventer',
    promptHint: 'Backflow prevention device',
    aliases: ['backflow', 'rpz', 'double check valve', 'backflow device'],
  },
  garbage_disposal: {
    canonical: 'garbage_disposal',
    displayLabel: 'Garbage Disposal',
    promptHint: 'Kitchen sink garbage disposal',
    aliases: ['disposal', 'disposer', 'food disposer'],
  },
  // Actions
  diagnostic: {
    canonical: 'diagnostic',
    displayLabel: 'Diagnostic',
    promptHint: 'Leak detection, camera inspection, or system evaluation',
    aliases: ['diagnosis', 'inspection', 'camera inspection', 'leak detection'],
  },
  repair: {
    canonical: 'repair',
    displayLabel: 'Repair',
    promptHint: 'Fix or restore plumbing component',
    aliases: ['fix', 'patch', 'service'],
  },
  install: {
    canonical: 'install',
    displayLabel: 'Installation',
    promptHint: 'New plumbing installation',
    aliases: ['installation', 'new install', 'hookup'],
  },
  replacement: {
    canonical: 'replacement',
    displayLabel: 'Replacement',
    promptHint: 'Replace existing plumbing component',
    aliases: ['replace', 'swap', 'changeout'],
  },
  // Qualifiers
  emergency: {
    canonical: 'emergency',
    displayLabel: 'Emergency',
    promptHint: 'Urgent or after-hours plumbing service',
    aliases: ['urgent', 'after-hours', 'emergency call', 'flood'],
  },
  preventive: {
    canonical: 'preventive',
    displayLabel: 'Preventive',
    promptHint: 'Preventive maintenance or inspection',
    aliases: ['preventive maintenance', 'routine', 'scheduled'],
  },
  warranty: {
    canonical: 'warranty',
    displayLabel: 'Warranty',
    promptHint: 'Covered under warranty',
    aliases: ['under warranty', 'warranty repair', 'warranty claim'],
  },
};
