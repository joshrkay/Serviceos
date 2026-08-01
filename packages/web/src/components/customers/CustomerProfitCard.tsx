import { ProfitCard } from '../reports/ProfitCard';

/**
 * Customer profitability (P&L) summary — revenue, costs, and margin rolled up
 * across the customer's jobs. Thin wrapper over the shared ProfitCard pointed
 * at GET /api/reports/customer-profit/:id.
 */
export function CustomerProfitCard({ customerId }: { customerId: string }) {
  return <ProfitCard endpoint={`/api/reports/customer-profit/${customerId}`} />;
}
