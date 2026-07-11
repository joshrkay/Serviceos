import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { Button } from '../../ui';

// Mirrors packages/api/src/settings/voice-approval-pin.ts
// (MIN_PIN_DIGITS/MAX_PIN_DIGITS) — packages/api is not importable from web,
// so the two constants are re-declared per this repo's convention.
const MIN_PIN_DIGITS = 4;
const MAX_PIN_DIGITS = 6;

/**
 * WS25 — onboarding capture for the WS21a voice-approval PIN (the spoken PIN
 * that gates money-class / irreversible VOICE approvals on a recognized owner
 * line). Sits inside the AI-check step next to VoiceConfigPanel, exactly like
 * that panel: self-contained, optional, and completely decoupled from the
 * step's completion gate — skipping it just leaves money approvals on the
 * one-tap SMS fallback.
 *
 * Security posture (why this is NOT the conversational onboarding proposer):
 * the digits live only in component state for the duration of the form and
 * are sent once over PUT /api/settings/voice-approval-pin, where they are
 * hashed at rest. They are never echoed back, never logged, and cleared from
 * state on success. Enrollment status is read as a boolean
 * (voiceApprovalPinEnrolled) from GET /api/settings — the credential itself
 * never round-trips.
 */
export function VoiceApprovalPinPanel() {
  const apiFetch = useApiClient();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enrolled, setEnrolled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Best-effort enrolled-state preload (same pattern as VoiceConfigPanel's
  // presets fetch) — on failure the panel just offers enrollment.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/settings/');
        if (!res.ok) return;
        const body = (await res.json()) as { voiceApprovalPinEnrolled?: boolean };
        if (active && body.voiceApprovalPinEnrolled) setEnrolled(true);
      } catch {
        // non-critical — the panel stays in its "set a PIN" state
      }
    })();
    return () => {
      active = false;
    };
  }, [apiFetch]);

  const digitsOnly = (raw: string) => raw.replace(/\D+/g, '').slice(0, MAX_PIN_DIGITS);
  const pinValid = pin.length >= MIN_PIN_DIGITS && pin.length <= MAX_PIN_DIGITS;

  async function save() {
    setError(null);
    if (!pinValid) {
      setError(`PIN must be ${MIN_PIN_DIGITS}–${MAX_PIN_DIGITS} digits.`);
      return;
    }
    if (pin !== confirm) {
      setError("PINs don't match.");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/voice-approval-pin', {
        method: 'PUT',
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        // 204 on success — a body only exists on error.
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `Couldn't save your PIN (HTTP ${res.status}).`);
        return;
      }
      // Never keep the digits around after the request succeeds.
      setPin('');
      setConfirm('');
      setEnrolled(true);
      setChanging(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (dismissed) return null;

  const showForm = !enrolled || changing;

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Voice approval PIN</h2>
        <p className="text-xs text-slate-500 mt-1">
          A {MIN_PIN_DIGITS}–{MAX_PIN_DIGITS} digit PIN you speak to approve money moves over the
          phone (like sending an invoice). Optional — without one, you approve by one-tap text
          instead.
        </p>
      </div>

      {enrolled && !changing && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
            <Check size={14} /> PIN enrolled
          </span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => {
              setChanging(true);
              setError(null);
            }}
          >
            Change PIN
          </Button>
        </div>
      )}

      {showForm && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="voice-approval-pin" className="block text-xs font-medium text-slate-700">
                PIN ({MIN_PIN_DIGITS}–{MAX_PIN_DIGITS} digits)
              </label>
              <input
                id="voice-approval-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={MAX_PIN_DIGITS}
                value={pin}
                onChange={(e) => setPin(digitsOnly(e.target.value))}
                placeholder="••••"
                className="mt-1 w-full min-h-11 rounded-lg border border-slate-200 px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="voice-approval-pin-confirm" className="block text-xs font-medium text-slate-700">
                Confirm PIN
              </label>
              <input
                id="voice-approval-pin-confirm"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={MAX_PIN_DIGITS}
                value={confirm}
                onChange={(e) => setConfirm(digitsOnly(e.target.value))}
                placeholder="••••"
                className="mt-1 w-full min-h-11 rounded-lg border border-slate-200 px-3 text-sm"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              className="min-h-11"
              loading={saving}
              disabled={saving || !pinValid || confirm.length === 0}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : enrolled ? 'Update PIN' : 'Set PIN'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={saving}
              onClick={() => {
                // Skip = drop the digits and collapse. No network call —
                // money-voice approvals keep the one-tap SMS fallback.
                setPin('');
                setConfirm('');
                if (enrolled) {
                  setChanging(false);
                  setError(null);
                } else {
                  setDismissed(true);
                }
              }}
            >
              {enrolled ? 'Cancel' : 'Skip for now'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
