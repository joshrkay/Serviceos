import { QuickBooksConnect } from '../components/integrations/QuickBooksConnect';

/**
 * Settings surface for third-party integrations (F17 / P15-001).
 */
export function IntegrationsSettings() {
  return (
    <div className="max-w-lg flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg text-slate-900">Integrations</h1>
        <p className="text-sm text-slate-500 mt-1">
          Connect accounting software to sync paid invoices and customers automatically.
        </p>
      </div>
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-medium text-slate-800 mb-4">QuickBooks Online</h2>
        <QuickBooksConnect />
      </section>
    </div>
  );
}
