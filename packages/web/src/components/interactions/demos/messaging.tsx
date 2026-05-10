import { useState } from 'react';
import {
  Sparkles, Check, X, Pencil, AlertCircle, Send,
  Clock, Calendar, User, MessageSquare, Phone,
  CheckCircle2, XCircle, Mail,
} from 'lucide-react';
import { AILabel } from '../shared';

// ── 1+3+4 · Draft SMS + Review + Send feedback ──────────────────────────
export function SMSDraftDemo() {
  const [editing, setEditing]   = useState(false);
  const [phase,   setPhase]     = useState<'draft' | 'review' | 'sent' | 'failed'>('draft');
  const [body,    setBody]      = useState("Hi Roberto! Confirming your HVAC appointment tomorrow, Mar 11 at 9:00 AM. Carlos Reyes will be on-site. Reply STOP to opt out. – Austin Pro Services");

  if (phase === 'sent') return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={20} className="text-green-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-green-900">SMS sent to Roberto Rodriguez</p>
        <p className="text-xs text-green-600">+1 (512) 555-0180 · {body.length} chars · Delivered 2:31 PM</p>
      </div>
      <button onClick={() => setPhase('draft')} className="text-xs text-green-700 hover:underline shrink-0">New draft</button>
    </div>
  );
  if (phase === 'failed') return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 flex items-center gap-3">
      <XCircle size={20} className="text-red-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-red-900">Failed to send</p>
        <p className="text-xs text-red-600">Carrier error — tap to retry</p>
      </div>
      <button onClick={() => setPhase('sent')} className="text-xs text-white bg-red-500 rounded-lg px-3 py-1.5 hover:bg-red-600 transition-colors shrink-0">Retry</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* To header */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 shrink-0" style={{ fontSize: 12 }}>RR</span>
        <div>
          <p className="text-sm text-slate-800">Roberto Rodriguez</p>
          <p className="text-xs text-slate-400">+1 (512) 555-0180 · SMS</p>
        </div>
        <span className="ml-auto flex items-center gap-1 text-xs text-indigo-600 bg-indigo-50 rounded-full px-2.5 py-0.5">
          <Sparkles size={9} /> AI drafted
        </span>
      </div>

      {/* Bubble */}
      {editing ? (
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={4}
          className="rounded-2xl border border-indigo-300 bg-indigo-50/30 px-4 py-3 text-sm text-slate-800 resize-none focus:outline-none focus:border-indigo-500 transition-colors"
        />
      ) : (
        <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-3">
          <p className="text-sm text-slate-800 leading-relaxed">{body}</p>
        </div>
      )}

      {/* Meta */}
      <div className="flex items-center justify-between">
        <p className={`text-xs ${body.length > 160 ? 'text-amber-600' : 'text-slate-400'}`}>
          {body.length} chars{body.length > 160 ? ' · 2 segments' : ' · 1 segment'}
        </p>
        <button onClick={() => setEditing(v => !v)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <Pencil size={10} /> {editing ? 'Done editing' : 'Edit'}
        </button>
      </div>

      {/* Review before send */}
      {phase === 'draft' && (
        <div className="rounded-xl bg-amber-50 border border-amber-100 px-3.5 py-3 flex items-start gap-2.5">
          <AlertCircle size={13} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-amber-700">Review before sending</p>
            <p className="text-xs text-amber-600 mt-0.5">Confirm time, name, and opt-out text are correct. Nothing has been sent yet.</p>
          </div>
          <button onClick={() => setPhase('review')} className="text-xs text-amber-700 hover:underline shrink-0">Review →</button>
        </div>
      )}

      {phase === 'review' && (
        <div className="rounded-xl bg-white border border-slate-200 px-4 py-3 flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
          <p className="text-xs text-slate-500">Review & send</p>
          <div className="flex gap-2">
            <button onClick={() => setPhase('sent')}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors">
              <Send size={13} /> Send SMS
            </button>
            <button onClick={() => setPhase('failed')}
              className="flex items-center justify-center rounded-xl border border-slate-200 text-slate-600 px-4 py-3 text-xs hover:bg-slate-50 transition-colors">
              Simulate fail
            </button>
          </div>
          <button onClick={() => setPhase('draft')} className="text-center text-xs text-slate-400 hover:text-slate-600">← Go back and edit</button>
        </div>
      )}
    </div>
  );
}

// ── 2 · Draft email ────────────────────────────────────────────────────────
export function EmailDraftDemo() {
  const [phase,   setPhase]   = useState<'draft' | 'sent'>('draft');
  const [subject, setSubject] = useState('Your estimate EST-0046 from Fieldly Pro Services — $4,220');
  const [body,    setBody]    = useState(`Hi Sarah,

Following up on the estimate we sent over for your HVAC service — EST-0046 for $4,220.

Let me know if you have any questions or if you'd like to discuss the scope. We can also adjust the quote if anything has changed.

Best,
Austin Pro Services | (512) 555-0000`);
  const [editField, setEdit] = useState<string | null>(null);

  if (phase === 'sent') return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5 flex items-center gap-3">
      <Mail size={16} className="text-green-500 shrink-0" />
      <div className="flex-1"><p className="text-sm text-green-900">Email sent to Sarah Davis</p><p className="text-xs text-green-600">sdavis@email.com · Delivered</p></div>
      <button onClick={() => setPhase('draft')} className="text-xs text-green-700 hover:underline">New draft</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="border-b border-slate-100">
        {[
          { label: 'To', value: 'Sarah Davis <sdavis@email.com>', key: 'to' },
          { label: 'Subject', value: subject, key: 'subject', onChange: setSubject },
        ].map(row => (
          <div key={row.key} className="flex items-start gap-3 px-4 py-2.5 border-b border-slate-50">
            <span className="text-xs text-slate-400 pt-0.5 w-12 shrink-0">{row.label}</span>
            {editField === row.key && row.onChange ? (
              <input value={row.value} onChange={e => row.onChange!(e.target.value)} onBlur={() => setEdit(null)}
                autoFocus className="flex-1 text-sm text-slate-800 focus:outline-none" />
            ) : (
              <p className="flex-1 text-sm text-slate-700 cursor-text" onClick={() => row.onChange && setEdit(row.key)}>{row.value}</p>
            )}
          </div>
        ))}
      </div>
      <div className="px-4 py-3">
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={6}
          className="w-full text-sm text-slate-700 resize-none focus:outline-none leading-relaxed" />
        <div className="flex items-center gap-1.5 mt-1">
          <Sparkles size={9} className="text-indigo-500" />
          <span className="text-xs text-indigo-600">AI drafted · review before sending</span>
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-100 bg-slate-50">
        <button onClick={() => setPhase('sent')}
          className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Send size={13} /> Send email
        </button>
        <span className="text-xs text-slate-400">Nothing sent yet</span>
      </div>
    </div>
  );
}

// ── 5 · Follow-up suggestion ──────────────────────────────────────────────
export function FollowUpDemo() {
  const [state, setState] = useState<'suggest' | 'draft' | 'scheduled' | 'snoozed'>('suggest');

  if (state === 'draft') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-slate-100 px-4 py-3 rounded-tl-sm">
        <p className="text-sm text-slate-800">Hi Sarah, just wanted to follow up on the estimate we sent for your HVAC system. Happy to answer any questions or adjust the scope. Let us know!</p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setState('scheduled')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Send size={13} /> Send now
        </button>
        <button onClick={() => setState('scheduled')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">
          <Clock size={13} /> Send tomorrow 9 AM
        </button>
      </div>
    </div>
  );
  if (state === 'scheduled') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <p className="text-sm text-green-900">Follow-up scheduled</p>
      <p className="text-xs text-green-600 mt-0.5">SMS to Sarah Davis · Tomorrow, Mar 11 at 9:00 AM</p>
      <button onClick={() => setState('suggest')} className="text-xs text-green-700 mt-1.5 hover:underline">Reset demo</button>
    </div>
  );
  if (state === 'snoozed') return (
    <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3.5">
      <p className="text-sm text-slate-600">Reminder set for 2 days from now</p>
      <button onClick={() => setState('suggest')} className="text-xs text-slate-400 mt-1.5 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-100">
          <Sparkles size={14} className="text-violet-600" />
        </div>
        <div className="flex-1">
          <p className="text-sm text-slate-800">Davis estimate hasn't had a response in <strong>3 days</strong></p>
          <p className="text-xs text-slate-500 mt-0.5">EST-0046 · $4,220 · Sent Mar 7 · Last seen: unread</p>
          <p className="text-sm text-slate-700 mt-2">Want me to draft a follow-up message?</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => setState('draft')} className="flex items-center gap-1.5 rounded-xl bg-violet-600 text-white px-3.5 py-2 text-xs hover:bg-violet-700 transition-colors">
              <MessageSquare size={11} /> Yes, draft one
            </button>
            <button onClick={() => setState('snoozed')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors">
              <Clock size={11} /> Remind me in 2 days
            </button>
            <button className="px-3.5 py-2 text-xs text-slate-400 hover:text-slate-600 transition-colors">Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 6+7 · Appointment confirm + Reschedule notice ────────────────────────
export function AppointmentDemo() {
  const [tab,   setTab]   = useState<'confirm' | 'reschedule'>('confirm');
  const [phase, setPhase] = useState<'draft' | 'sent'>('draft');
  const [reason, setReason] = useState('Tech unavailable');

  function reset() { setPhase('draft'); }

  const reasons = ['Tech unavailable', 'Weather conditions', 'Customer request', 'Equipment delay'];

  if (phase === 'sent') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={18} className="text-green-500 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-green-900">{tab === 'confirm' ? 'Confirmation sent' : 'Reschedule notice sent'} to Roberto</p>
        <p className="text-xs text-green-600">SMS delivered · 2:33 PM</p>
      </div>
      <button onClick={reset} className="text-xs text-green-700 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Tab toggle */}
      <div className="flex gap-1.5 p-1 rounded-xl bg-slate-100">
        {(['confirm', 'reschedule'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setPhase('draft'); }}
            className={`flex-1 rounded-lg py-2 text-xs transition-all ${
              tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {t === 'confirm' ? '📅 Appointment confirm' : '🔄 Reschedule notice'}
          </button>
        ))}
      </div>

      {tab === 'confirm' ? (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
            <div className="flex items-center gap-1.5">
              <Sparkles size={10} className="text-indigo-500" />
              <p className="text-xs text-indigo-600">AI drafted · Appointment confirmation</p>
            </div>
          </div>
          <div className="px-4 py-3 flex flex-col gap-2.5">
            {[
              { icon: Calendar, label: 'Date', value: 'Wednesday, March 11, 2026' },
              { icon: Clock,    label: 'Time', value: '9:00 AM – 11:00 AM (est.)' },
              { icon: User,     label: 'Tech', value: 'Carlos Reyes · HVAC certified' },
              { icon: Phone,    label: 'Contact', value: '(512) 555-0000 if needed' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-2.5">
                <Icon size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs text-slate-400 w-14 shrink-0">{label}</span>
                <span className="text-sm text-slate-800">{value}</span>
              </div>
            ))}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-3 mt-1">
              <p className="text-xs text-slate-500 leading-relaxed">Preview SMS: "Hi Roberto! Confirming your HVAC service tomorrow Mar 11 at 9AM. Carlos Reyes will be on-site. Questions? (512) 555-0000"</p>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-slate-100">
            <button onClick={() => setPhase('sent')} className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm hover:bg-slate-700 transition-colors">
              <Send size={13} /> Send confirmation
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-100 bg-amber-50">
            <div className="flex items-center gap-1.5">
              <Sparkles size={10} className="text-amber-600" />
              <p className="text-xs text-amber-700">Reschedule notice</p>
            </div>
          </div>
          <div className="px-4 py-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2.5">
                <p className="text-xs text-red-600 mb-0.5">Was</p>
                <p className="text-sm text-red-800">Wed Mar 11 · 9AM</p>
              </div>
              <div className="rounded-xl bg-green-50 border border-green-100 px-3 py-2.5">
                <p className="text-xs text-green-600 mb-0.5">Now</p>
                <p className="text-sm text-green-800">Thu Mar 12 · 10AM</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1.5">Reason (included in message)</p>
              <div className="flex flex-wrap gap-1.5">
                {reasons.map(r => (
                  <button key={r} onClick={() => setReason(r)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-all ${
                      reason === r ? 'border-amber-500 bg-amber-100 text-amber-800' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}>{r}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5">
              <p className="text-xs text-slate-500 leading-relaxed">Preview: "Hi Roberto, we need to reschedule your Mar 11 9AM appointment to Mar 12 at 10AM due to {reason.toLowerCase()}. Apologies for the inconvenience. – Austin Pro Services"</p>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-amber-100">
            <button onClick={() => setPhase('sent')} className="flex items-center gap-2 rounded-xl bg-amber-600 text-white px-4 py-2.5 text-sm hover:bg-amber-700 transition-colors">
              <Send size={13} /> Send reschedule notice
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
