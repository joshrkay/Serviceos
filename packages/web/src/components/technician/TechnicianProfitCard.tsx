import { ProfitCard } from '../reports/ProfitCard';

/**
 * Technician profitability (P&L) summary — revenue, costs, and margin rolled up
 * across the jobs assigned to a technician. Thin wrapper over the shared
 * ProfitCard pointed at GET /api/reports/technician-profit/:id. The endpoint is
 * invoices:view-gated, so the card hides (403 → unavailable) for viewers who
 * shouldn't see margins.
 */
export function TechnicianProfitCard({ technicianId }: { technicianId: string }) {
  return (
    <ProfitCard
      endpoint={`/api/reports/technician-profit/${technicianId}`}
      title="Technician profitability"
    />
  );
}
