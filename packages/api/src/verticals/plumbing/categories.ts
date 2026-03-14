import { PlumbingServiceCategory } from '../../shared/vertical-types';

export interface PlumbingCategoryDefinition {
  id: PlumbingServiceCategory;
  name: string;
  description: string;
  parentId?: string;
  sortOrder: number;
  typicalLineItems: string[];
}

export const PLUMBING_CATEGORIES: PlumbingCategoryDefinition[] = [
  {
    id: 'diagnostic',
    name: 'Diagnostic',
    description: 'Leak detection, camera inspection, and plumbing evaluation',
    sortOrder: 1,
    typicalLineItems: [
      'Service call / diagnostic fee',
      'Camera inspection',
      'Leak detection',
      'Pressure test',
      'System evaluation',
    ],
  },
  {
    id: 'repair',
    name: 'Repair',
    description: 'Fix or restore plumbing components and systems',
    sortOrder: 2,
    typicalLineItems: [
      'Pipe repair',
      'Faucet repair',
      'Toilet repair',
      'Valve replacement',
      'Leak repair',
      'Fixture repair',
    ],
  },
  {
    id: 'install',
    name: 'Installation',
    description: 'New plumbing fixture or component installation',
    sortOrder: 3,
    typicalLineItems: [
      'Fixture installation',
      'Faucet installation',
      'Toilet installation',
      'Garbage disposal installation',
      'Water line hookup',
      'Drain line connection',
    ],
  },
  {
    id: 'replacement',
    name: 'Replacement',
    description: 'Replace existing plumbing equipment or major components',
    sortOrder: 4,
    typicalLineItems: [
      'Old fixture removal',
      'New fixture supply',
      'Fixture installation',
      'Water line modification',
      'Drain modification',
      'Disposal of old equipment',
    ],
  },
  {
    id: 'drain',
    name: 'Drain Service',
    description: 'Drain cleaning, clearing, and maintenance',
    sortOrder: 5,
    typicalLineItems: [
      'Drain cleaning',
      'Snake / auger service',
      'Hydro-jetting',
      'Drain camera inspection',
      'Root removal',
      'Trap cleaning',
    ],
  },
  {
    id: 'water-heater',
    name: 'Water Heater',
    description: 'Water heater repair, maintenance, and installation',
    sortOrder: 6,
    typicalLineItems: [
      'Water heater diagnostic',
      'Thermostat replacement',
      'Anode rod replacement',
      'Element replacement',
      'Tank flush',
      'New water heater installation',
      'Old water heater removal and disposal',
    ],
  },
  {
    id: 'emergency',
    name: 'Emergency',
    description: 'Urgent or after-hours plumbing service',
    sortOrder: 7,
    typicalLineItems: [
      'Emergency service call',
      'After-hours diagnostic',
      'Emergency repair labor',
      'Water shutoff service',
      'Emergency parts markup',
    ],
  },
];

export function validatePlumbingCategoryTaxonomy(categories: PlumbingCategoryDefinition[]): string[] {
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
