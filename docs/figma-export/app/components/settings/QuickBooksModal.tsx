import { useState } from 'react';
import { X, Check, Link, RefreshCw, AlertCircle, ChevronRight, Clock } from 'lucide-react';

type ConnectStep = 'idle' | 'connecting' | 'connected';

interface SyncSettings {
  invoices:  boolean;
  payments:  boolean;
  customers: boolean;
  estimates: boolean;
}

export function QuickBooksModal({ onClose }: { onClose: () => void }) {
  const [step, setStep]             = useState<ConnectStep>('idle');
  const [sync, setSync]             = useState<SyncSettings>({
    invoices:  true,
    payments:  true,
    customers: true,
    estimates: false,
  });
  const [autoSync, setAutoSync]     = useState(true);

  function handleConnect() {
    setStep('connecting');
    setTimeout(() => setStep('connected'), 1800);
  }

  function toggleSync(key: keyof SyncSettings) {
    setSync(prev => ({ ...prev, [key]: !prev[key] }));
  }

  const SYNC_OPTIONS: { key: keyof SyncSettings; label: string; desc: string }[] = [
    { key: 'invoices',  label: 'Invoices',      desc: 'Sync invoices to QuickBooks automatically' },
    { key: 'payments',  label: 'Payments',       desc: 'Mark invoices as paid when payment received' },
    { key: 'customers', label: 'Customers',      desc: 'Keep customer records in sync' },
    { key: 'estimates', label: 'Estimates',      desc: 'Sync approved estimates as QuickBooks quotes' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 px-4 pb-0 md:pb-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white rounded-t-3xl md:rounded-2xl shadow-2xl overflow-hidden"
        style={{ animation: 'sheetUp 0.25s ease' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 px-5 pt-5 pb-4 border-b border-slate-100">
          {/* QB logo */}
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#2CA01C] text-white text-xs font-mono">
            QB
          </div>
          <div className="flex-1">
            <p className="text-slate-900">QuickBooks Online</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {step === 'connected' ? 'Connected · Ortega HVAC & Services' : 'Not connected'}
            </p>
          </div>
          {step === 'connected' && (
            <span className="flex items-center gap-1.5 text-xs text-green-700 bg-green-100 rounded-full px-2.5 py-1">
              <span className="size-1.5 rounded-full bg-green-500" /> Live
            </span>
          )}
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-5 max-h-[70vh] overflow-y-auto">

          {/* ── Idle: not connected ── */}
          {step === 'idle' && (
            <div className="flex flex-col gap-5">
              <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-4">
                <p className="text-sm text-slate-700 leading-relaxed">
                  Connect Fieldly to QuickBooks Online to automatically sync invoices, payments, and customers — no double entry.
                </p>
              </div>

              <div className="flex flex-col gap-2.5">
                {[
                  'Invoices auto-sync when sent or paid',
                  'Customer records stay in sync',
                  'No manual data entry between apps',
                  'Works with QuickBooks Simple Start and up',
                ].map(item => (
                  <div key={item} className="flex items-center gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green-100">
                      <Check size={11} className="text-green-600" />
                    </span>
                    <p className="text-sm text-slate-600">{item}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertCircle size={13} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700">
                    You'll be redirected to QuickBooks to authorize access. This is a secure OAuth connection — Fieldly never sees your QuickBooks password.
                  </p>
                </div>
              </div>

              <button
                onClick={handleConnect}
                className="flex items-center justify-center gap-2 rounded-xl bg-[#2CA01C] hover:bg-[#238C15] text-white py-3.5 text-sm transition-colors"
              >
                <Link size={14} />
                Connect QuickBooks
              </button>

              <p className="text-center text-xs text-slate-400">
                Requires QuickBooks Online · Simple Start, Essentials, or Plus
              </p>
            </div>
          )}

          {/* ── Connecting ── */}
          {step === 'connecting' && (
            <div className="flex flex-col items-center gap-6 py-10">
              <div className="relative flex size-16 items-center justify-center">
                <div className="absolute inset-0 rounded-full border-4 border-slate-100" />
                <div className="absolute inset-0 rounded-full border-4 border-[#2CA01C] border-t-transparent animate-spin" />
                <span className="text-[#2CA01C] text-sm font-mono">QB</span>
              </div>
              <div className="text-center">
                <p className="text-slate-900">Connecting to QuickBooks…</p>
                <p className="text-xs text-slate-400 mt-1.5">Authorizing via OAuth 2.0</p>
              </div>
            </div>
          )}

          {/* ── Connected ── */}
          {step === 'connected' && (
            <div className="flex flex-col gap-5">
              {/* Success banner */}
              <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-4 flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-100">
                  <Check size={16} className="text-green-600" />
                </span>
                <div>
                  <p className="text-sm text-green-800">Connected successfully</p>
                  <p className="text-xs text-green-600 mt-0.5">Syncing to: Ortega HVAC & Services · QBO ID #8821</p>
                </div>
              </div>

              {/* Sync settings */}
              <div>
                <p className="text-xs text-slate-500 mb-3">Sync settings</p>
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  {SYNC_OPTIONS.map(({ key, label, desc }, i) => (
                    <div
                      key={key}
                      className={`flex items-center justify-between px-4 py-3.5 ${i > 0 ? 'border-t border-slate-100' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">{label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{desc}</p>
                      </div>
                      <button
                        onClick={() => toggleSync(key)}
                        className={`relative flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ml-4 ${sync[key] ? 'bg-slate-900' : 'bg-slate-200'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${sync[key] ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Auto sync */}
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3.5">
                <div>
                  <p className="text-sm text-slate-800">Auto-sync frequency</p>
                  <p className="text-xs text-slate-400 mt-0.5">{autoSync ? 'Every 15 minutes' : 'Manual only'}</p>
                </div>
                <button
                  onClick={() => setAutoSync(v => !v)}
                  className={`relative flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${autoSync ? 'bg-slate-900' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${autoSync ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Last sync log */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">Recent sync activity</p>
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  {[
                    { icon: Check,      text: 'INV-0089 synced – David Chen',       time: 'Just now', color: 'text-green-500' },
                    { icon: Check,      text: 'Customer records synced (10)',        time: '1 min ago', color: 'text-green-500' },
                    { icon: RefreshCw,  text: 'Initial sync complete',              time: '2 min ago', color: 'text-blue-500' },
                  ].map(({ icon: Icon, text, time, color }, i) => (
                    <div key={i} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
                      <Icon size={13} className={`shrink-0 ${color}`} />
                      <p className="text-xs text-slate-600 flex-1">{text}</p>
                      <span className="text-xs text-slate-400 flex items-center gap-1 shrink-0">
                        <Clock size={10} /> {time}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Disconnect */}
              <button className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 py-3 text-sm transition-colors">
                Disconnect QuickBooks
              </button>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes sheetUp { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}
