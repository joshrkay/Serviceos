/**
 * P18 — Route optimization voice skill (v1 reorder proposal).
 */
export interface OptimizeRouteInput {
  appointmentIds: string[];
  travelMinutes: number[];
}

export interface OptimizeRouteResult {
  orderedIds: string[];
  totalTravelMinutes: number;
}

export function optimizeRouteOrder(input: OptimizeRouteInput): OptimizeRouteResult {
  const pairs = input.appointmentIds.map((id, index) => ({
    id,
    travel: input.travelMinutes[index] ?? 0,
  }));
  pairs.sort((a, b) => a.travel - b.travel);
  return {
    orderedIds: pairs.map((p) => p.id),
    totalTravelMinutes: pairs.reduce((sum, p) => sum + p.travel, 0),
  };
}
