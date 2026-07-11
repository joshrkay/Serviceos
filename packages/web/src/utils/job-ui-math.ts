import type { MaterialItem } from '../types/job-ui';

export function calcMaterialsTotal(materials: MaterialItem[]): number {
  return materials.reduce((s, m) => s + m.qty * m.unitCost, 0);
}

/**
 * Human "Est. Nh Nm" label derived from a real appointment window
 * (scheduledStart → scheduledEnd). Returns null when either bound is
 * missing/unparseable or the window is non-positive, so callers omit the
 * line rather than showing a fabricated constant. Timezone-agnostic: it
 * measures elapsed duration between two instants, not wall-clock rendering.
 */
export function formatAppointmentDurationLabel(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const totalMinutes = Math.round((end - start) / 60000);
  if (totalMinutes <= 0) return null;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return `Est. ${parts.join(' ')}`;
}
