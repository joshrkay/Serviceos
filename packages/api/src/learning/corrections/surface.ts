/**
 * P2-038 — Format correction lessons for digest display.
 */
export function formatCorrectionLessons(
  entries: Array<{ proposalType: string; editedFields: string[] }>,
): string[] {
  return entries
    .filter((e) => e.editedFields.length > 0)
    .map((e) => `Learned: on ${e.proposalType}, you prefer ${e.editedFields.join(', ')}`)
    .slice(0, 5);
}
