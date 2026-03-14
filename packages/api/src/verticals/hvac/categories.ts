import { HvacServiceCategory } from '../../shared/vertical-types';

export interface ServiceCategoryDefinition {
  id: HvacServiceCategory;
  name: string;
  description: string;
  parentId?: string;
  sortOrder: number;
  typicalLineItems: string[];
}

export const HVAC_CATEGORIES: ServiceCategoryDefinition[] = [
  {
    id: 'diagnostic',
    name: 'Diagnostic',
    description: 'System diagnostic, troubleshooting, and evaluation services',
    sortOrder: 1,
    typicalLineItems: [
      'Diagnostic service call',
      'System inspection',
      'Thermostat calibration check',
      'Refrigerant pressure test',
      'Electrical component testing',
    ],
  },
  {
    id: 'repair',
    name: 'Repair',
    description: 'Fix or restore HVAC components and systems',
    sortOrder: 2,
    typicalLineItems: [
      'Compressor repair',
      'Fan motor replacement',
      'Capacitor replacement',
      'Contactor replacement',
      'Refrigerant recharge',
      'Ductwork repair',
      'Thermostat replacement',
    ],
  },
  {
    id: 'maintenance',
    name: 'Maintenance',
    description: 'Preventive and routine maintenance services',
    sortOrder: 3,
    typicalLineItems: [
      'Annual tune-up',
      'Filter replacement',
      'Coil cleaning',
      'Condensate drain cleaning',
      'Belt inspection and adjustment',
      'Lubrication of moving parts',
    ],
  },
  {
    id: 'install',
    name: 'Installation',
    description: 'New equipment installation',
    sortOrder: 4,
    typicalLineItems: [
      'Equipment delivery',
      'New system installation',
      'Ductwork installation',
      'Thermostat installation',
      'Electrical hookup',
      'Refrigerant line installation',
      'System startup and testing',
    ],
  },
  {
    id: 'replacement',
    name: 'Replacement',
    description: 'Replace existing HVAC equipment or major components',
    sortOrder: 5,
    typicalLineItems: [
      'Old equipment removal',
      'New equipment supply',
      'Equipment installation',
      'Ductwork modification',
      'Electrical modification',
      'System startup and commissioning',
      'Disposal of old equipment',
    ],
  },
  {
    id: 'emergency',
    name: 'Emergency',
    description: 'Urgent or after-hours HVAC service',
    sortOrder: 6,
    typicalLineItems: [
      'Emergency service call',
      'After-hours diagnostic',
      'Emergency repair labor',
      'Emergency parts markup',
    ],
  },
];

export function validateCategoryTaxonomy(categories: ServiceCategoryDefinition[]): string[] {
  const errors: string[] = [];

  if (categories.length === 0) {
    errors.push('Category taxonomy must have at least one entry');
    return errors;
  }

  const ids = new Set<string>();
  for (const cat of categories) {
    if (!cat.id) {
      errors.push('Category id is required');
      continue;
    }
    if (ids.has(cat.id)) {
      errors.push(`Duplicate category id: ${cat.id}`);
    }
    ids.add(cat.id);

    if (!cat.name) errors.push(`Category "${cat.id}" is missing name`);
    if (!cat.description) errors.push(`Category "${cat.id}" is missing description`);
    if (cat.parentId && !ids.has(cat.parentId)) {
      // parentId must reference an already-seen id (assumes sorted order)
      const parentExists = categories.some((c) => c.id === cat.parentId);
      if (!parentExists) {
        errors.push(`Category "${cat.id}" references unknown parentId: ${cat.parentId}`);
      }
    }
  }

  return errors;
}
