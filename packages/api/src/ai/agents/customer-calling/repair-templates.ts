import type { RepairTemplate } from '../../../verticals/registry';

export interface RepairContext {
  trigger: RepairTemplate['trigger'];
}

/**
 * Pick a repair template for the FSM to speak. Returns the first
 * template that matches the requested trigger, or falls back to the
 * `low_intent_confidence` template if the exact trigger has no entry
 * (intent-level reprompt is the safest default).
 *
 * Returns undefined only when the vertical pack supplied no templates
 * at all — caller is expected to fall back to the existing generic
 * reprompt in that case.
 */
export function selectRepairTemplate(
  templates: ReadonlyArray<RepairTemplate>,
  ctx: RepairContext
): RepairTemplate | undefined {
  if (templates.length === 0) return undefined;
  const exact = templates.find((t) => t.trigger === ctx.trigger);
  if (exact) return exact;
  return templates.find((t) => t.trigger === 'low_intent_confidence');
}
