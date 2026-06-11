import type { MaterialItem } from '../types/job-ui';

export function calcEstimateTotalFromLines(
  lineItems: Array<{ qty: number; rate: number }>,
): number {
  return lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
}

export function calcMaterialsTotal(materials: MaterialItem[]): number {
  return materials.reduce((s, m) => s + m.qty * m.unitCost, 0);
}
