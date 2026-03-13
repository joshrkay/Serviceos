export interface TerminologyEntry {
  canonical: string;
  displayLabel: string;
  promptHint: string;
  aliases: string[];
}

export type TerminologyMap = Record<string, TerminologyEntry>;

export const HVAC_TERMINOLOGY: TerminologyMap = {
  // Equipment
  furnace: {
    canonical: 'furnace',
    displayLabel: 'Furnace',
    promptHint: 'Gas or electric furnace heating unit',
    aliases: ['heater', 'heating unit', 'gas furnace', 'electric furnace'],
  },
  ac_unit: {
    canonical: 'ac_unit',
    displayLabel: 'AC Unit',
    promptHint: 'Air conditioning unit or central air system',
    aliases: ['air conditioner', 'central air', 'cooling unit', 'a/c', 'ac'],
  },
  heat_pump: {
    canonical: 'heat_pump',
    displayLabel: 'Heat Pump',
    promptHint: 'Heat pump for heating and cooling',
    aliases: ['mini split', 'ductless', 'split system'],
  },
  ductwork: {
    canonical: 'ductwork',
    displayLabel: 'Ductwork',
    promptHint: 'Air distribution duct system',
    aliases: ['ducts', 'air ducts', 'duct system', 'ventilation ducts'],
  },
  thermostat: {
    canonical: 'thermostat',
    displayLabel: 'Thermostat',
    promptHint: 'Temperature control device',
    aliases: ['temp control', 'programmable thermostat', 'smart thermostat'],
  },
  compressor: {
    canonical: 'compressor',
    displayLabel: 'Compressor',
    promptHint: 'Refrigerant compressor unit',
    aliases: ['ac compressor', 'refrigerant compressor'],
  },
  condenser: {
    canonical: 'condenser',
    displayLabel: 'Condenser',
    promptHint: 'Outdoor condenser coil or unit',
    aliases: ['condenser coil', 'outdoor unit', 'condenser unit'],
  },
  evaporator_coil: {
    canonical: 'evaporator_coil',
    displayLabel: 'Evaporator Coil',
    promptHint: 'Indoor evaporator coil',
    aliases: ['evap coil', 'indoor coil', 'a-coil'],
  },
  air_handler: {
    canonical: 'air_handler',
    displayLabel: 'Air Handler',
    promptHint: 'Indoor air handling unit',
    aliases: ['blower', 'fan coil', 'air handling unit'],
  },
  refrigerant: {
    canonical: 'refrigerant',
    displayLabel: 'Refrigerant',
    promptHint: 'Cooling refrigerant (R-410A, R-22, etc.)',
    aliases: ['freon', 'coolant', 'r-410a', 'r-22'],
  },
  // Actions
  diagnostic: {
    canonical: 'diagnostic',
    displayLabel: 'Diagnostic',
    promptHint: 'System diagnostic and troubleshooting',
    aliases: ['diagnosis', 'troubleshooting', 'inspection', 'evaluation'],
  },
  repair: {
    canonical: 'repair',
    displayLabel: 'Repair',
    promptHint: 'Fix or restore component',
    aliases: ['fix', 'service', 'restore'],
  },
  maintenance: {
    canonical: 'maintenance',
    displayLabel: 'Maintenance',
    promptHint: 'Preventive or routine maintenance',
    aliases: ['tune-up', 'service call', 'preventive maintenance', 'pm'],
  },
  install: {
    canonical: 'install',
    displayLabel: 'Installation',
    promptHint: 'New equipment installation',
    aliases: ['installation', 'new install', 'setup'],
  },
  replacement: {
    canonical: 'replacement',
    displayLabel: 'Replacement',
    promptHint: 'Replace existing equipment or component',
    aliases: ['replace', 'swap', 'changeout', 'change out'],
  },
  // Qualifiers
  emergency: {
    canonical: 'emergency',
    displayLabel: 'Emergency',
    promptHint: 'Urgent or after-hours service',
    aliases: ['urgent', 'after-hours', 'emergency call'],
  },
  seasonal: {
    canonical: 'seasonal',
    displayLabel: 'Seasonal',
    promptHint: 'Seasonal preparation or check',
    aliases: ['spring check', 'fall check', 'winterize', 'pre-season'],
  },
  warranty: {
    canonical: 'warranty',
    displayLabel: 'Warranty',
    promptHint: 'Covered under warranty',
    aliases: ['under warranty', 'warranty repair', 'warranty claim'],
  },
};

export function validateTerminologyMap(map: TerminologyMap): string[] {
  const errors: string[] = [];
  const keys = Object.keys(map);

  if (keys.length === 0) {
    errors.push('Terminology map must have at least one entry');
    return errors;
  }

  for (const key of keys) {
    if (!key || key.trim().length === 0) {
      errors.push('Terminology key must not be empty');
      continue;
    }
    const entry = map[key];
    if (!entry.canonical) errors.push(`Entry "${key}" is missing canonical`);
    if (!entry.displayLabel) errors.push(`Entry "${key}" is missing displayLabel`);
    if (!entry.promptHint) errors.push(`Entry "${key}" is missing promptHint`);
    if (!Array.isArray(entry.aliases)) errors.push(`Entry "${key}" is missing aliases array`);
  }

  return errors;
}
