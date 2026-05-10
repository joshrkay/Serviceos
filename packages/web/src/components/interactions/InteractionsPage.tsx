import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { DemoCard } from './shared';
import {
  ProposeDemo, ApproveDemo, EditDemo, RejectDemo,
  ExplanationDemo, ConfidenceDemo, ClarificationDemo, AutoAppliedDemo,
} from './demos/ai';
import {
  SMSDraftDemo, EmailDraftDemo, FollowUpDemo, AppointmentDemo,
} from './demos/messaging';
import {
  CreateFromConvoDemo, MoveJobDemo, AssignTechDemo, ConflictDemo, SyncStatusDemo,
} from './demos/scheduling';
import {
  CustomerMatchDemo, JobMatchDemo, CreateLeadDemo, DuplicateWarningDemo, MergeCandidateDemo,
} from './demos/records';
import {
  EstimateDraftDemo, PricingReviewDemo, ApprovalCaptureDemo,
  InvoiceDraftDemo, PaymentHandoffDemo, CancellationFeeDemo,
} from './demos/financial';
import {
  VoiceCaptureDemo, ConfigProposalDemo, RuleConfirmationDemo, UnsupportedPrefDemo,
} from './demos/onboarding';
import {
  LoadingDemo, EmptyDemo, ErrorDemo, RetryDemo, PendingReviewDemo,
  SuccessDemo, PartialFailureDemo, DisconnectedDemo, SyncDelayedDemo,
} from './demos/system-states';

const TABS = [
  { id: 'ai',          label: 'AI',           count: 8  },
  { id: 'messaging',   label: 'Messaging',    count: 7  },
  { id: 'scheduling',  label: 'Scheduling',   count: 5  },
  { id: 'records',     label: 'Records',      count: 5  },
  { id: 'financial',   label: 'Financial',    count: 6  },
  { id: 'onboarding',  label: 'Onboarding',   count: 5  },
  { id: 'states',      label: 'System States',count: 9  },
] as const;
type TabId = typeof TABS[number]['id'];

export function InteractionsPage() {
  const [tab, setTab] = useState<TabId>('ai');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-5 pt-5 pb-0 border-b border-slate-100 bg-white">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-slate-900">Interaction Patterns</h1>
              <p className="text-sm text-slate-400 mt-0.5">45 live patterns — click and interact with each</p>
            </div>
            <span className="flex size-8 items-center justify-center rounded-xl bg-indigo-100">
              <Sparkles size={15} className="text-indigo-600" />
            </span>
          </div>
          <div className="flex gap-0.5 overflow-x-auto pb-0" style={{ scrollbarWidth: 'none' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2.5 text-sm border-b-2 whitespace-nowrap transition-all shrink-0 ${
                  tab === t.id
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {t.label}
                <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                  tab === t.id ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'
                }`}>{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-6 pb-20 flex flex-col gap-5">

          {/* ── AI tab ── */}
          {tab === 'ai' && (
            <>
              <DemoCard tag="Propose action" onReset={() => {}}>
                <ProposeDemo />
              </DemoCard>
              <DemoCard tag="Approve action" tagColor="bg-green-100 text-green-700">
                <ApproveDemo />
              </DemoCard>
              <DemoCard tag="Edit action" tagColor="bg-indigo-100 text-indigo-700">
                <EditDemo />
              </DemoCard>
              <DemoCard tag="Reject action" tagColor="bg-red-100 text-red-700">
                <RejectDemo />
              </DemoCard>
              <DemoCard tag="Show brief explanation" tagColor="bg-slate-100 text-slate-600" title="Why this suggestion?">
                <ExplanationDemo />
              </DemoCard>
              <DemoCard tag="Confidence & ambiguity cue" tagColor="bg-amber-100 text-amber-700" title="Tap a card to expand">
                <ConfidenceDemo />
              </DemoCard>
              <DemoCard tag="Ask targeted clarification" tagColor="bg-violet-100 text-violet-700">
                <ClarificationDemo />
              </DemoCard>
              <DemoCard tag="Auto-applied update" tagColor="bg-green-100 text-green-700" title="Silent updates with undo">
                <AutoAppliedDemo />
              </DemoCard>
            </>
          )}

          {/* ── Messaging tab ── */}
          {tab === 'messaging' && (
            <>
              <DemoCard tag="Draft SMS · Review · Send feedback" tagColor="bg-blue-100 text-blue-700" title="Covers 3 patterns">
                <SMSDraftDemo />
              </DemoCard>
              <DemoCard tag="Draft email message" tagColor="bg-blue-100 text-blue-700" title="AI-drafted, fully editable">
                <EmailDraftDemo />
              </DemoCard>
              <DemoCard tag="Reminder / follow-up suggestion" tagColor="bg-violet-100 text-violet-700">
                <FollowUpDemo />
              </DemoCard>
              <DemoCard tag="Appointment confirm · Reschedule notice" tagColor="bg-amber-100 text-amber-700" title="Toggle between types">
                <AppointmentDemo />
              </DemoCard>
            </>
          )}

          {/* ── Scheduling tab ── */}
          {tab === 'scheduling' && (
            <>
              <DemoCard tag="Create schedule from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateFromConvoDemo />
              </DemoCard>
              <DemoCard tag="Move job from conversation" tagColor="bg-blue-100 text-blue-700">
                <MoveJobDemo />
              </DemoCard>
              <DemoCard tag="Assign technician from calendar" tagColor="bg-green-100 text-green-700" title="Thu Mar 12 availability">
                <AssignTechDemo />
              </DemoCard>
              <DemoCard tag="Resolve scheduling conflict" tagColor="bg-red-100 text-red-700">
                <ConflictDemo />
              </DemoCard>
              <DemoCard tag="External calendar sync status" tagColor="bg-slate-100 text-slate-600" title="Tap to cycle states">
                <SyncStatusDemo />
              </DemoCard>
            </>
          )}

          {/* ── Records tab ── */}
          {tab === 'records' && (
            <>
              <DemoCard tag="Resolve customer match" tagColor="bg-amber-100 text-amber-700" title="Match before creating contact">
                <CustomerMatchDemo />
              </DemoCard>
              <DemoCard tag="Resolve job match" tagColor="bg-orange-100 text-orange-700" title="Possible duplicate job">
                <JobMatchDemo />
              </DemoCard>
              <DemoCard tag="Create new lead/job from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateLeadDemo />
              </DemoCard>
              <DemoCard tag="Surface duplicate warning" tagColor="bg-red-100 text-red-700" title="Inline while creating">
                <DuplicateWarningDemo />
              </DemoCard>
              <DemoCard tag="Review suggested merge candidate" tagColor="bg-violet-100 text-violet-700" title="Field-level conflict resolution">
                <MergeCandidateDemo />
              </DemoCard>
            </>
          )}

          {/* ── Financial tab ── */}
          {tab === 'financial' && (
            <>
              <DemoCard tag="Estimate draft from conversation" tagColor="bg-indigo-100 text-indigo-700" title="Plain language → line items">
                <EstimateDraftDemo />
              </DemoCard>
              <DemoCard tag="Pricing suggestion review" tagColor="bg-green-100 text-green-700" title="Per-line accept or keep">
                <PricingReviewDemo />
              </DemoCard>
              <DemoCard tag="Estimate approval capture" tagColor="bg-blue-100 text-blue-700" title="Signature + metadata recorded">
                <ApprovalCaptureDemo />
              </DemoCard>
              <DemoCard tag="Invoice draft from job completion" tagColor="bg-slate-100 text-slate-600" title="Complete → draft → send">
                <InvoiceDraftDemo />
              </DemoCard>
              <DemoCard tag="Hosted payment handoff" tagColor="bg-green-100 text-green-700" title="Link generation + delivery">
                <PaymentHandoffDemo />
              </DemoCard>
              <DemoCard tag="Cancellation / no-show fee suggestion" tagColor="bg-amber-100 text-amber-700">
                <CancellationFeeDemo />
              </DemoCard>
            </>
          )}

          {/* ── Onboarding tab ── */}
          {tab === 'onboarding' && (
            <>
              <DemoCard tag="Voice answer capture · Text fallback" tagColor="bg-red-100 text-red-700" title="Toggle between modes">
                <VoiceCaptureDemo />
              </DemoCard>
              <DemoCard tag="Config proposal review" tagColor="bg-indigo-100 text-indigo-700" title="Toggle inferred settings on/off">
                <ConfigProposalDemo />
              </DemoCard>
              <DemoCard tag="Rule confirmation" tagColor="bg-violet-100 text-violet-700" title="Confirm, edit, or skip">
                <RuleConfirmationDemo />
              </DemoCard>
              <DemoCard tag="Unsupported preference capture" tagColor="bg-slate-100 text-slate-600" title="3 examples — tap to switch">
                <UnsupportedPrefDemo />
              </DemoCard>
            </>
          )}

          {/* ── System States tab ── */}
          {tab === 'states' && (
            <>
              <DemoCard tag="Loading" tagColor="bg-blue-100 text-blue-700" title="Skeleton · Spinner · Progress">
                <LoadingDemo />
              </DemoCard>
              <DemoCard tag="Empty" tagColor="bg-slate-100 text-slate-600" title="Jobs · Invoices · Schedule contexts">
                <EmptyDemo />
              </DemoCard>
              <DemoCard tag="Error" tagColor="bg-red-100 text-red-700" title="Network · Validation · Permission">
                <ErrorDemo />
              </DemoCard>
              <DemoCard tag="Retry" tagColor="bg-amber-100 text-amber-700" title="Exponential backoff + drain animation">
                <RetryDemo />
              </DemoCard>
              <DemoCard tag="Pending review" tagColor="bg-indigo-100 text-indigo-700" title="AI action queue · approve / reject each">
                <PendingReviewDemo />
              </DemoCard>
              <DemoCard tag="Success" tagColor="bg-green-100 text-green-700" title="Toast · Inline · Full-screen">
                <SuccessDemo />
              </DemoCard>
              <DemoCard tag="Partial failure" tagColor="bg-orange-100 text-orange-700" title="Batch send · n of n succeeded">
                <PartialFailureDemo />
              </DemoCard>
              <DemoCard tag="Disconnected / weak connectivity" tagColor="bg-red-100 text-red-700" title="Online · Weak · Offline">
                <DisconnectedDemo />
              </DemoCard>
              <DemoCard tag="Sync delayed" tagColor="bg-amber-100 text-amber-700" title="Escalating staleness · Sync now">
                <SyncDelayedDemo />
              </DemoCard>
            </>
          )}

        </div>
      </div>

      <style>{`@keyframes stepIn { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} }`}</style>
    </div>
  );
}
