export type VerticalType = 'hvac' | 'plumbing';

export const VALID_VERTICAL_TYPES: VerticalType[] = ['hvac', 'plumbing'];

export type PackStatus = 'draft' | 'active' | 'deprecated';

export const VALID_PACK_STATUSES: PackStatus[] = ['draft', 'active', 'deprecated'];

export type HvacServiceCategory =
  | 'diagnostic'
  | 'repair'
  | 'maintenance'
  | 'install'
  | 'replacement'
  | 'emergency';

export const HVAC_SERVICE_CATEGORIES: HvacServiceCategory[] = [
  'diagnostic', 'repair', 'maintenance', 'install', 'replacement', 'emergency',
];

export type PlumbingServiceCategory =
  | 'diagnostic'
  | 'repair'
  | 'install'
  | 'replacement'
  | 'drain'
  | 'water-heater'
  | 'emergency';

export const PLUMBING_SERVICE_CATEGORIES: PlumbingServiceCategory[] = [
  'diagnostic', 'repair', 'install', 'replacement', 'drain', 'water-heater', 'emergency',
];

export type ServiceCategory = HvacServiceCategory | PlumbingServiceCategory;

export function isValidVerticalType(value: string): value is VerticalType {
  return VALID_VERTICAL_TYPES.includes(value as VerticalType);
}

export function isValidPackStatus(value: string): value is PackStatus {
  return VALID_PACK_STATUSES.includes(value as PackStatus);
}

export function getServiceCategories(verticalType: VerticalType): ServiceCategory[] {
  switch (verticalType) {
    case 'hvac':
      return [...HVAC_SERVICE_CATEGORIES];
    case 'plumbing':
      return [...PLUMBING_SERVICE_CATEGORIES];
  }
}
