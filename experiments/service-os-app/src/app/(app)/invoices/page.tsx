'use client';

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Plus, X } from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
}

interface Invoice {
  id: string;
  amount_cents: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  description: string;
  created_at: string;
  due_at?: string | null;
  customers?: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
  };
}

interface ItemForm {
  description: string;
  qty: number;
  unitPriceDollars: number;
}

const DEFAULT_ITEM: ItemForm = { description: '', qty: 1, unitPriceDollars: 0 };

function parseDocumentType(description: string) {
  if (description.startsWith('Type: estimate')) return 'Estimate';
  return 'Invoice';
}

function formatSummary(docType: 'invoice' | 'estimate', serviceItems: ItemForm[], partItems: ItemForm[]) {
  const lines: string[] = [`Type: ${docType}`, 'Services:'];

  if (serviceItems.length === 0) {
    lines.push('- none');
  } else {
    for (const s of serviceItems) {
      lines.push(`- ${s.description} (qty ${s.qty}, $${s.unitPriceDollars.toFixed(2)} each)`);
    }
  }

  lines.push('Parts:');
  if (partItems.length === 0) {
    lines.push('- none');
  } else {
    for (const p of partItems) {
      lines.push(`- ${p.description} (qty ${p.qty}, $${p.unitPriceDollars.toFixed(2)} each)`);
    }
  }

  return lines.join('\n');
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [docType, setDocType] = useState<'invoice' | 'estimate'>('invoice');
  const [services, setServices] = useState<ItemForm[]>([{ ...DEFAULT_ITEM }]);
  const [parts, setParts] = useState<ItemForm[]>([{ ...DEFAULT_ITEM }]);

  useEffect(() => {
    Promise.all([fetch('/api/invoices'), fetch('/api/customers')])
      .then(async ([invoiceRes, customerRes]) => {
        const [invoiceData, customerData] = await Promise.all([invoiceRes.json(), customerRes.json()]);
        if (invoiceRes.ok) setInvoices(invoiceData);
        if (customerRes.ok) {
          setCustomers(customerData);
          if (customerData.length > 0) setCustomerId(customerData[0].id);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const selectedCustomer = customers.find(c => c.id === customerId);

  const validServices = services.filter(s => s.description.trim().length > 0);
  const validParts = parts.filter(p => p.description.trim().length > 0);

  const totalCents = useMemo(() => {
    const calc = (items: ItemForm[]) => items.reduce((sum, item) => sum + item.qty * Math.round(item.unitPriceDollars * 100), 0);
    return calc(validServices) + calc(validParts);
  }, [validServices, validParts]);

  function updateItem(
    list: ItemForm[],
    setList: Dispatch<SetStateAction<ItemForm[]>>,
    index: number,
    patch: Partial<ItemForm>,
  ) {
    setList(list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addRow(setter: Dispatch<SetStateAction<ItemForm[]>>) {
    setter(prev => [...prev, { ...DEFAULT_ITEM }]);
  }

  function removeRow(
    list: ItemForm[],
    setter: Dispatch<SetStateAction<ItemForm[]>>,
    index: number,
  ) {
    if (list.length === 1) return;
    setter(list.filter((_, i) => i !== index));
  }

  async function createInvoice(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!customerId) {
      setFormError('Please choose a client.');
      return;
    }

    if (validServices.length + validParts.length === 0) {
      setFormError('Add at least one service or part.');
      return;
    }

    const description = formatSummary(docType, validServices, validParts);

    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId,
        amount_cents: totalCents,
        status: 'draft',
        description,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      setFormError(err.error || 'Failed to create invoice');
      return;
    }

    const newInvoice = await res.json();
    setInvoices(prev => [newInvoice, ...prev]);
    setShowForm(false);
    setDocType('invoice');
    setServices([{ ...DEFAULT_ITEM }]);
    setParts([{ ...DEFAULT_ITEM }]);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-4 pb-2 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Invoices</h1>
        <button
          onClick={() => setShowForm(true)}
          className="size-8 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-4 pb-4">
        {loading ? (
          <p className="text-sm text-slate-400 text-center mt-8">Loading...</p>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-slate-400 text-center mt-8">No invoices yet</p>
        ) : (
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Client</th>
                  <th className="text-left px-3 py-2 font-medium">Total</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{parseDocumentType(inv.description)}</td>
                    <td className="px-3 py-2">{inv.customers?.name || 'Unknown'}</td>
                    <td className="px-3 py-2">${(inv.amount_cents / 100).toFixed(2)}</td>
                    <td className="px-3 py-2 capitalize">{inv.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl p-5 space-y-4 max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Create New {docType === 'estimate' ? 'Estimate' : 'Invoice'}</h2>
              <button onClick={() => setShowForm(false)}>
                <X size={20} className="text-slate-400" />
              </button>
            </div>

            <form className="space-y-4" onSubmit={createInvoice}>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Document type</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setDocType('invoice')}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      docType === 'invoice' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200'
                    }`}
                  >
                    Invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocType('estimate')}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      docType === 'estimate' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200'
                    }`}
                  >
                    Estimate
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Client</label>
                <select
                  required
                  value={customerId}
                  onChange={e => setCustomerId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                >
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {selectedCustomer && (
                  <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 space-y-0.5">
                    {selectedCustomer.phone && <p>Phone: {selectedCustomer.phone}</p>}
                    {selectedCustomer.email && <p>Email: {selectedCustomer.email}</p>}
                    {selectedCustomer.address && <p>Address: {selectedCustomer.address}</p>}
                  </div>
                )}
              </div>

              <ItemEditor
                label="Services"
                items={services}
                onAdd={() => addRow(setServices)}
                onChange={(i, patch) => updateItem(services, setServices, i, patch)}
                onRemove={i => removeRow(services, setServices, i)}
              />

              <ItemEditor
                label="Parts"
                items={parts}
                onAdd={() => addRow(setParts)}
                onChange={(i, patch) => updateItem(parts, setParts, i, patch)}
                onRemove={i => removeRow(parts, setParts, i)}
              />

              <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm flex items-center justify-between">
                <span>Total</span>
                <span className="font-semibold">${(totalCents / 100).toFixed(2)}</span>
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <button
                type="submit"
                className="w-full rounded-lg bg-blue-600 text-white py-2.5 text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Create {docType === 'estimate' ? 'Estimate' : 'Invoice'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemEditor({
  label,
  items,
  onAdd,
  onChange,
  onRemove,
}: {
  label: string;
  items: ItemForm[];
  onAdd: () => void;
  onChange: (index: number, patch: Partial<ItemForm>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <button type="button" onClick={onAdd} className="text-xs text-blue-600 hover:text-blue-700">
          + Add
        </button>
      </div>

      {items.map((item, index) => (
        <div key={`${label}-${index}`} className="grid grid-cols-[1fr_80px_100px_26px] gap-2 items-center">
          <input
            placeholder={`${label.slice(0, -1)} description`}
            value={item.description}
            onChange={e => onChange(index, { description: e.target.value })}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
          />
          <input
            type="number"
            min={1}
            value={item.qty}
            onChange={e => onChange(index, { qty: Math.max(1, Number(e.target.value) || 1) })}
            className="rounded-lg border border-slate-200 px-2 py-2 text-sm outline-none focus:border-blue-400"
          />
          <input
            type="number"
            min={0}
            step="0.01"
            value={item.unitPriceDollars}
            onChange={e => onChange(index, { unitPriceDollars: Math.max(0, Number(e.target.value) || 0) })}
            className="rounded-lg border border-slate-200 px-2 py-2 text-sm outline-none focus:border-blue-400"
          />
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="text-slate-400 hover:text-slate-700"
            aria-label={`Remove ${label} item ${index + 1}`}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
