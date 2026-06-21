import { Navigate } from 'react-router';
import { useMe } from '../../hooks/useMe';
import { Spinner } from '../ui';
import { HomePage } from './HomePage';

/**
 * Epic 12.1 — role-based landing.
 *
 * Technicians land on the field-focused TechJobView (`/technician/day`);
 * every other role (owner, dispatcher) lands on the owner command surface
 * (HomePage). We wait for `/api/me` to resolve before deciding so a
 * technician never flashes the owner dashboard. If the identity lookup
 * fails, we fall back to HomePage — the safe default for the majority
 * (owners/dispatchers) rather than locking anyone out.
 */
export function RoleHome() {
  const { me, isLoading } = useMe();

  if (isLoading && !me) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (me?.role === 'technician') {
    return <Navigate to="/technician/day" replace />;
  }

  return <HomePage />;
}
