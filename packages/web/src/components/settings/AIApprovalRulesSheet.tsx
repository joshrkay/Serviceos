/**
 * AI approval rules — confidence thresholds for auto-approve, by
 * who's on shift:
 *
 *   - Supervisor present (default 0.9)
 *   - Hybrid / "both" mode (default 0.92)
 *   - Tech-only (default 0.95) — strictest because no human supervisor
 *
 * Two presentation modes:
 *   - "Approval mode" picker — Strict / Balanced / Permissive — maps
 *     to a 3-mode threshold tuple. Most tenants pick a preset and
 *     never touch advanced.
 *   - "Advanced" reveal — three number inputs (0.50–0.99) for tenants
 *     who want per-mode tuning.
 *
 * Backend: PUT /api/settings { autoApproveThreshold: {...} }.
 * Thresholds feed createProposal's auto-approve decision.
 */
import { useEffect, useState } from 'react';
import { X, Zap, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';
import type { Mode } from '@ai-service-os/shared';

type ThresholdMap = Partial<Record<Mode, number>>;

const DEFAULTS: Record<Mode, number> = {
  supervisor: 0.9,
  both: 0.92,
  tech: 0.95,
};

interface Preset {
  id: 'strict' | 'balanced' | 'permissive' | 'custom';
  label: string;
  description: string;
  thresholds?: Record<Mode, number>;
}

const PRESETS: readonly Preset[] = [
  {
    id: 'strict',
    label: 'Strict',
    description: 'AI rarely auto-approves. Most proposals queue for human review.',
    thresholds: { supervisor: 0.95, both: 0.97, tech: 0.99 },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default. Auto-approves high-confidence proposals; queues the rest.',
    thresholds: { ...DEFAULTS },
  },
  {
    id: 'permissive',
    label: 'Permissive',
    description: 'AI auto-approves more aggressively. Best for trusted-vertical pilots.',
    thresholds: { supervisor: 0.85, both: 0.88, tech: 0.92 },
  },
];

/**
 * UB-D / D-015 — autonomous booking lane bounds. Mirrors the API contract
 * (updateSettingsSchema) and the tenant_settings CHECK: 0.90–0.99,
 * default 0.95.
 */
const AUTONOMOUS_THRESHOLD_DEFAULT = 0.95;
const AUTONOMOUS_THRESHOLD_MIN = 0.9;
const AUTONOMOUS_THRESHOLD_MAX = 0.99;

function matchPreset(thresholds: ThresholdMap): Preset['id'] {
  for (const p of PRESETS) {
    if (!p.thresholds) continue;
    const match =
      thresholds.supervisor === p.thresholds.supervisor &&
      thresholds.both === p.thresholds.both &&
      thresholds.tech === p.thresholds.tech;
    if (match) return p.id;
  }
  return 'custom';
}

interface AIApprovalRulesSheetProps {
  onClose: () => void;
}

export function AIApprovalRulesSheet({ onClose }: AIApprovalRulesSheetProps) {
  const [thresholds, setThresholds] = useState<ThresholdMap>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // UB-D / D-015 — autonomous booking lane (opt-in, default OFF).
  const [autonomousEnabled, setAutonomousEnabled] = useState(false);
  const [autonomousThreshold, setAutonomousThreshold] = useState<number | undefined>(
    AUTONOMOUS_THRESHOLD_DEFAULT,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as {
          autoApproveThreshold?: ThresholdMap;
          autonomousBookingEnabled?: boolean;
          autonomousBookingThreshold?: number;
        };
        if (cancelled) return;
        setAutonomousEnabled(data.autonomousBookingEnabled ?? false);
        setAutonomousThreshold(
          data.autonomousBookingThreshold ?? AUTONOMOUS_THRESHOLD_DEFAULT,
        );
        const loaded: ThresholdMap = data.autoApproveThreshold ?? {};
        // If no override exists, prefill with the Balanced (default)
        // preset so users see meaningful values rather than empty
        // inputs. Saving without changes still sends the same map.
        if (Object.keys(loaded).length === 0) {
          setThresholds({ ...DEFAULTS });
        } else {
          setThresholds(loaded);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load approval rules');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyPreset(preset: Preset) {
    if (!preset.thresholds) return;
    setThresholds({ ...preset.thresholds });
  }

  async function save() {
    setError('');
    // Validate every present field is in [0, 1]; reject NaN.
    for (const k of ['supervisor', 'tech', 'both'] as Mode[]) {
      const v = thresholds[k];
      if (v === undefined) continue;
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        setError(`${k}: threshold must be between 0 and 1`);
        return;
      }
    }
    // UB-D / D-015 — the autonomous threshold must sit in the lane's bounds
    // (the API rejects anything outside 0.90–0.99).
    const at = autonomousThreshold;
    if (
      at === undefined ||
      !Number.isFinite(at) ||
      at < AUTONOMOUS_THRESHOLD_MIN ||
      at > AUTONOMOUS_THRESHOLD_MAX
    ) {
      setError(
        `Autonomous booking threshold must be between ${AUTONOMOUS_THRESHOLD_MIN} and ${AUTONOMOUS_THRESHOLD_MAX}`,
      );
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoApproveThreshold: thresholds,
          autonomousBookingEnabled: autonomousEnabled,
          autonomousBookingThreshold: at,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      toast.success('Approval rules saved');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const activePresetId = matchPreset(thresholds);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="ai-rules-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Zap size={16} className="text-slate-700" />
          </span>
          <h2 id="ai-rules-title" className="flex-1 text-base text-slate-900">
            AI approval rules
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Set how confident the AI must be before a proposal auto-applies.
            Anything below the threshold queues for human review. Higher = stricter.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              {/* Preset picker. */}
              <div className="space-y-2">
                {PRESETS.map((p) => {
                  const active = activePresetId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                        active
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm ${active ? 'text-indigo-900' : 'text-slate-800'}`}>
                          {p.label}
                        </span>
                        {active && (
                          <span className="text-xs text-indigo-600" aria-label="Selected">
                            ✓
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{p.description}</p>
                    </button>
                  );
                })}
                {activePresetId === 'custom' && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    Custom thresholds — not matching any preset.
                  </div>
                )}
              </div>

              {/* Advanced reveal — per-mode number inputs. */}
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-800 transition-colors"
                aria-expanded={advancedOpen}
              >
                Advanced
                <ChevronDown
                  size={14}
                  className={`transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {advancedOpen && (
                <div className="space-y-3 rounded-xl bg-slate-50 px-4 py-3">
                  {(['supervisor', 'both', 'tech'] as Mode[]).map((mode) => {
                    const labelMap: Record<Mode, string> = {
                      supervisor: 'Supervisor present',
                      both: 'Hybrid (both modes)',
                      tech: 'Tech-only (no supervisor)',
                    };
                    const id = `threshold-${mode}`;
                    const value = thresholds[mode] ?? DEFAULTS[mode];
                    return (
                      <label key={mode} htmlFor={id} className="block">
                        <span className="text-sm text-slate-700">
                          {labelMap[mode]}{' '}
                          <span className="text-slate-400">→ default {DEFAULTS[mode]}</span>
                        </span>
                        <input
                          id={id}
                          type="number"
                          step="0.01"
                          min="0.5"
                          max="0.99"
                          value={value}
                          onChange={(e) => {
                            const n = parseFloat(e.target.value);
                            setThresholds((t) => ({
                              ...t,
                              [mode]: Number.isFinite(n) ? n : undefined,
                            }));
                          }}
                          className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors bg-white"
                        />
                      </label>
                    );
                  })}
                </div>
              )}

              {/* UB-D / D-015 — autonomous booking lane (opt-in, default OFF). */}
              <div className="space-y-3 rounded-xl border border-slate-200 px-4 py-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={autonomousEnabled}
                  onClick={() => setAutonomousEnabled((v) => !v)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
                >
                  <span className="text-sm text-slate-800">
                    Autonomous booking (no supervisor)
                  </span>
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      autonomousEnabled ? 'bg-indigo-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block size-4 rounded-full bg-white transition-transform ${
                        autonomousEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </span>
                </button>
                <p className="text-xs text-slate-500">
                  When on, high-confidence bookings from the AI receptionist confirm
                  instantly with no one watching. You get an SMS with one-tap UNDO for
                  every one.
                </p>
                {autonomousEnabled && (
                  <label htmlFor="autonomous-booking-threshold" className="block">
                    <span className="text-sm text-slate-700">
                      Confidence threshold{' '}
                      <span className="text-slate-400">
                        → default {AUTONOMOUS_THRESHOLD_DEFAULT}
                      </span>
                    </span>
                    <input
                      id="autonomous-booking-threshold"
                      type="number"
                      step="0.01"
                      min={AUTONOMOUS_THRESHOLD_MIN}
                      max={AUTONOMOUS_THRESHOLD_MAX}
                      value={autonomousThreshold ?? ''}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        setAutonomousThreshold(Number.isFinite(n) ? n : undefined);
                      }}
                      className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors bg-white"
                    />
                  </label>
                )}
              </div>

              {error && (
                <p className="text-sm text-red-600" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
