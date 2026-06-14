import { toast } from 'sonner';
import { VoiceBar } from '../../shared/VoiceBar';
import { useApiClient, type ApiFetch } from '../../../lib/apiClient';

/**
 * Voice-first onboarding intake. Renders the shared VoiceBar capture surface
 * across the wizard so an operator can SPEAK their business into existence
 * ("I run Bob's HVAC, open 8 to 5 weekdays, we do AC repair…") instead of
 * typing each form. The transcript is POSTed to /api/onboarding/voice, which
 * extracts a business profile, hours, pack, pricing, and team into
 * human-approved proposals the operator reviews in the inbox. The step forms
 * below remain the fallback + edit surface for anything voice misses.
 */

export interface OnboardingVoiceResult {
  proposalIds: string[];
  needsClarification: boolean;
  clarificationQuestions: string[];
}

/**
 * POST a spoken onboarding transcript and return the extraction result.
 * Extracted as a pure-ish helper so the dispatch logic is unit-testable
 * without driving the browser mic pipeline.
 */
export async function submitOnboardingVoice(
  apiFetch: ApiFetch,
  transcript: string,
): Promise<OnboardingVoiceResult> {
  const res = await apiFetch('/api/onboarding/voice', {
    method: 'POST',
    body: JSON.stringify({ transcript }),
  });
  if (!res.ok) {
    throw new Error('Voice onboarding request failed');
  }
  return (await res.json()) as OnboardingVoiceResult;
}

interface OnboardingVoiceIntakeProps {
  /** Fired after proposals are created so the shell can refetch status. */
  onProposalsCreated?: () => void;
  variant?: 'mobile' | 'desktop';
}

export function OnboardingVoiceIntake({
  onProposalsCreated,
  variant = 'mobile',
}: OnboardingVoiceIntakeProps) {
  const apiFetch = useApiClient();

  const handleTranscript = async (transcript: string) => {
    try {
      const result = await submitOnboardingVoice(apiFetch, transcript);
      const count = result.proposalIds.length;
      if (count > 0) {
        toast.success(
          `Captured ${count} setup ${count === 1 ? 'item' : 'items'} — review and approve in your inbox.`,
        );
        onProposalsCreated?.();
      } else if (result.needsClarification) {
        toast.message('I caught most of it — a couple details need a quick answer in your inbox.');
        onProposalsCreated?.();
      } else {
        toast.message(
          "I didn't catch any setup details. Try saying your business name, what you do, and your hours.",
        );
      }
    } catch {
      toast.error('Could not process that. Please try again.');
    }
  };

  return (
    <div className="mb-6 rounded-2xl border border-blue-100 bg-blue-50/40 p-3 sm:p-4">
      <p className="mb-2 px-1 text-sm font-medium text-slate-700">
        Set up by voice — just talk
      </p>
      <p className="mb-3 px-1 text-xs text-slate-500">
        Tell me your business name, what you do, your hours, and your rates. I&apos;ll fill in
        the setup for you to approve. Prefer typing? The form below still works.
      </p>
      <VoiceBar
        variant={variant}
        onSubmit={handleTranscript}
        idlePrompt="Tell me about your business…"
        idleHint="tap to speak"
      />
    </div>
  );
}
