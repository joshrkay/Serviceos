/**
 * P10-001 — High-level summary cards: open invoices, upcoming
 * appointments, active estimates. The numbers are computed client-side
 * over the same lists the dedicated tabs render — no extra endpoints.
 */
import { useEffect, useState } from 'react';
import {
  PortalAppointment,
  PortalCustomer,
  PortalEstimate,
  PortalInvoice,
  formatPortalCents,
  portalApi,
} from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';

interface Props {
  token: string;
  customer: PortalCustomer;
}

interface Snapshot {
  invoices: PortalInvoice[];
  estimates: PortalEstimate[];
  appointments: PortalAppointment[];
  loaded: boolean;
  error: string | null;
}

export function PortalDashboard({ token, customer }: Props) {
  const [snap, setSnap] = useState<Snapshot>({
    invoices: [],
    estimates: [],
    appointments: [],
    loaded: false,
    error: null,
  });
  const [cancelling, setCancelling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  async function cancelAppointment(appointmentId: string) {
    setCancelErr(null);
    setCancelling(true);
    try {
      const res = await portalApi.cancelAppointment(token, appointmentId);
      setCancelMsg(res.message);
    } catch (err) {
      setCancelErr((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      portalApi.invoices(token),
      portalApi.estimates(token),
      portalApi.appointments(token, { upcoming: true }),
    ])
      .then(([inv, est, appt]) => {
        if (cancelled) return;
        setSnap({
          invoices: inv.invoices,
          estimates: est.estimates,
          appointments: appt.appointments,
          loaded: true,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setSnap((s) => ({ ...s, loaded: true, error: err.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!snap.loaded) {
    return <div className="text-slate-500">Loading…</div>;
  }
  if (snap.error) {
    return <div className="text-rose-600 text-sm">{snap.error}</div>;
  }

  const dueInvoices = snap.invoices.filter((i) => i.amountDueCents > 0);
  const totalDueCents = dueInvoices.reduce((sum, i) => sum + i.amountDueCents, 0);
  const openEstimates = snap.estimates.filter((e) =>
    ['draft', 'sent', 'ready_for_review'].includes(e.status),
  );
  const nextAppt = snap.appointments[0];

  return (
    <div className="space-y-3">
      <PortalCard
        title="Amount due"
        trailing={
          <span className="text-lg font-semibold text-slate-900">
            {formatPortalCents(totalDueCents)}
          </span>
        }
      >
        {dueInvoices.length === 0
          ? 'You have no outstanding invoices.'
          : `${dueInvoices.length} invoice${dueInvoices.length === 1 ? '' : 's'} awaiting payment.`}
      </PortalCard>

      <PortalCard
        title="Open estimates"
        trailing={<span className="text-lg font-semibold text-slate-900">{openEstimates.length}</span>}
      >
        {openEstimates.length === 0
          ? 'No estimates pending review.'
          : 'Review and approve estimates from the Estimates tab.'}
      </PortalCard>

      <PortalCard
        title="Next appointment"
        trailing={
          nextAppt ? (
            <span className="text-sm text-slate-700">
              {new Date(nextAppt.scheduledStart).toLocaleString()}
            </span>
          ) : null
        }
      >
        {nextAppt
          ? `Status: ${nextAppt.status.replace(/_/g, ' ')}`
          : 'Nothing scheduled. Use Book appointment to schedule a visit.'}
        {nextAppt && !cancelMsg ? (
          <div className="mt-3">
            <button
              type="button"
              disabled={cancelling}
              onClick={() => void cancelAppointment(nextAppt.id)}
              className="text-sm text-rose-600 hover:underline disabled:opacity-50"
            >
              {cancelling ? 'Requesting…' : 'Cancel this appointment'}
            </button>
            {cancelErr ? <div className="mt-1 text-xs text-rose-600">{cancelErr}</div> : null}
          </div>
        ) : null}
        {cancelMsg ? <div className="mt-3 text-sm text-emerald-700">{cancelMsg}</div> : null}
      </PortalCard>

      <div className="text-xs text-slate-400 pt-2">
        Logged in as {customer.email ?? customer.displayName}
      </div>
    </div>
  );
}
