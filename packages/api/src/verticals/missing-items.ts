// P4-008A/008B: Missing-Item Detection Signals
// Detects commonly forgotten line items in estimates based on vertical knowledge

import { LineItem } from '../shared/billing-engine';
import { VerticalType, VerticalPack } from './registry';

export interface MissingItemSignal {
  severity: 'warning' | 'info';
  message: string;
  suggestedDescription: string;
  suggestedCategory: 'labor' | 'material' | 'equipment' | 'other';
  suggestedUnitPriceCents?: number;
  suggestedQuantity?: number;
  reason: string;
}

export interface MissingItemRule {
  id: string;
  verticalType: VerticalType;
  categoryId: string;
  name: string;
  description: string;
  condition: MissingItemCondition;
  suggestion: MissingItemSuggestion;
  isActive: boolean;
}

export interface MissingItemCondition {
  type: 'requires_with' | 'minimum_items' | 'category_missing';
  /** For requires_with: if any line item matches triggerPattern, check that requiredPattern also exists */
  triggerPattern?: string;
  requiredPattern?: string;
  /** For minimum_items: minimum count of items in a category */
  minimumCount?: number;
  targetCategory?: string;
}

export interface MissingItemSuggestion {
  description: string;
  category: 'labor' | 'material' | 'equipment' | 'other';
  defaultUnitPriceCents?: number;
  defaultQuantity?: number;
}

export function detectMissingItems(
  lineItems: LineItem[],
  rules: MissingItemRule[],
  categoryId: string
): MissingItemSignal[] {
  const signals: MissingItemSignal[] = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.categoryId !== categoryId && rule.categoryId !== '*') continue;

    const signal = evaluateRule(rule, lineItems);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

function evaluateRule(rule: MissingItemRule, lineItems: LineItem[]): MissingItemSignal | null {
  const { condition, suggestion } = rule;

  switch (condition.type) {
    case 'requires_with': {
      if (!condition.triggerPattern || !condition.requiredPattern) return null;
      const triggerRegex = new RegExp(condition.triggerPattern, 'i');
      const requiredRegex = new RegExp(condition.requiredPattern, 'i');
      const hasTrigger = lineItems.some((li) => triggerRegex.test(li.description));
      const hasRequired = lineItems.some((li) => requiredRegex.test(li.description));
      if (hasTrigger && !hasRequired) {
        return {
          severity: 'warning',
          message: rule.description,
          suggestedDescription: suggestion.description,
          suggestedCategory: suggestion.category,
          suggestedUnitPriceCents: suggestion.defaultUnitPriceCents,
          suggestedQuantity: suggestion.defaultQuantity,
          reason: `"${condition.triggerPattern}" found but "${condition.requiredPattern}" is missing`,
        };
      }
      return null;
    }

    case 'minimum_items': {
      if (!condition.targetCategory || condition.minimumCount === undefined) return null;
      const count = lineItems.filter((li) => li.category === condition.targetCategory).length;
      if (count < condition.minimumCount) {
        return {
          severity: 'info',
          message: rule.description,
          suggestedDescription: suggestion.description,
          suggestedCategory: suggestion.category,
          suggestedUnitPriceCents: suggestion.defaultUnitPriceCents,
          suggestedQuantity: suggestion.defaultQuantity,
          reason: `Expected at least ${condition.minimumCount} ${condition.targetCategory} items, found ${count}`,
        };
      }
      return null;
    }

    case 'category_missing': {
      if (!condition.targetCategory) return null;
      const hasCategory = lineItems.some((li) => li.category === condition.targetCategory);
      if (!hasCategory) {
        return {
          severity: 'info',
          message: rule.description,
          suggestedDescription: suggestion.description,
          suggestedCategory: suggestion.category,
          suggestedUnitPriceCents: suggestion.defaultUnitPriceCents,
          suggestedQuantity: suggestion.defaultQuantity,
          reason: `No ${condition.targetCategory} items found in estimate`,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

// Default HVAC missing-item rules
export const HVAC_MISSING_ITEM_RULES: MissingItemRule[] = [
  {
    id: 'hvac-rule-001',
    verticalType: 'hvac',
    categoryId: 'hvac-install-ac',
    name: 'AC install requires thermostat check',
    description: 'AC installation typically requires thermostat compatibility check or upgrade',
    condition: {
      type: 'requires_with',
      triggerPattern: 'ac|air conditioner|cooling.*install',
      requiredPattern: 'thermostat',
    },
    suggestion: {
      description: 'Thermostat compatibility check',
      category: 'labor',
      defaultUnitPriceCents: 7500,
      defaultQuantity: 1,
    },
    isActive: true,
  },
  {
    id: 'hvac-rule-002',
    verticalType: 'hvac',
    categoryId: 'hvac-install-ac',
    name: 'AC install requires refrigerant',
    description: 'AC installation typically includes refrigerant charge',
    condition: {
      type: 'requires_with',
      triggerPattern: 'ac|air conditioner.*install',
      requiredPattern: 'refrigerant|freon|r-?410a',
    },
    suggestion: {
      description: 'Refrigerant charge (R-410A)',
      category: 'material',
      defaultUnitPriceCents: 7500,
      defaultQuantity: 1,
    },
    isActive: true,
  },
  {
    id: 'hvac-rule-003',
    verticalType: 'hvac',
    categoryId: '*',
    name: 'Labor items check',
    description: 'Most HVAC estimates should include labor charges',
    condition: {
      type: 'category_missing',
      targetCategory: 'labor',
    },
    suggestion: {
      description: 'Labor',
      category: 'labor',
      defaultUnitPriceCents: 12500,
      defaultQuantity: 1,
    },
    isActive: true,
  },
];

// Default Plumbing missing-item rules
export const PLUMBING_MISSING_ITEM_RULES: MissingItemRule[] = [
  {
    id: 'plumb-rule-001',
    verticalType: 'plumbing',
    categoryId: 'plumb-install-waterheater',
    name: 'Water heater install requires permits',
    description: 'Water heater installation typically requires permit and inspection',
    condition: {
      type: 'requires_with',
      triggerPattern: 'water heater.*install|install.*water heater',
      requiredPattern: 'permit|inspection',
    },
    suggestion: {
      description: 'Permit and inspection fee',
      category: 'other',
      defaultUnitPriceCents: 15000,
      defaultQuantity: 1,
    },
    isActive: true,
  },
  {
    id: 'plumb-rule-002',
    verticalType: 'plumbing',
    categoryId: 'plumb-install-waterheater',
    name: 'Water heater install requires disposal',
    description: 'Water heater replacement includes old unit disposal',
    condition: {
      type: 'requires_with',
      triggerPattern: 'water heater.*install|water heater.*replace',
      requiredPattern: 'disposal|haul.*away|remove.*old',
    },
    suggestion: {
      description: 'Old water heater disposal',
      category: 'labor',
      defaultUnitPriceCents: 7500,
      defaultQuantity: 1,
    },
    isActive: true,
  },
  {
    id: 'plumb-rule-003',
    verticalType: 'plumbing',
    categoryId: '*',
    name: 'Labor items check',
    description: 'Most plumbing estimates should include labor charges',
    condition: {
      type: 'category_missing',
      targetCategory: 'labor',
    },
    suggestion: {
      description: 'Labor',
      category: 'labor',
      defaultUnitPriceCents: 11500,
      defaultQuantity: 1,
    },
    isActive: true,
  },
];
