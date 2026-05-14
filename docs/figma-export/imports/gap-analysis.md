# Figma Design vs. Web Implementation — Gap Analysis

**Generated:** 2026-03-15
**Figma export:** `figma-export/app/`
**Web implementation:** `packages/web/src/`

---

## Executive Summary

| Category | Figma | Web | Gap Severity |
|---|---|---|---|
| Shell / Layout | ✅ Full desktop + mobile | ❌ Missing | **CRITICAL** |
| Home Dashboard | ✅ Rich 2-col, widgets | ❌ Missing | **CRITICAL** |
| AI Chat Interface | ✅ Full (voice, reactions, proposals) | ⚠️ Skeleton | **HIGH** |
| Job Details | ✅ Rich (modals, timeline, materials) | ⚠️ Skeleton | **HIGH** |
| Technician View | ✅ Voice parsing + parts catalog | ⚠️ Basic voice only | **HIGH** |
| Estimates | ✅ Approval flow + AI hints | ⚠️ List only | **MEDIUM** |
| Invoices | ✅ Payment journey + methods UI | ⚠️ List only | **MEDIUM** |
| Customers | ✅ Full CRUD + locations | ⚠️ List only | **MEDIUM** |
| Schedule / Dispatch | ✅ Day-view calendar | ⚠️ Kanban lanes (different UX) | **MEDIUM** |
| AI Proposal Cards | ✅ Rich (edit, confidence, states) | ⚠️ Basic | **MEDIUM** |
| Leads / Interactions | ✅ Full pages | ❌ Missing | **MEDIUM** |
| Onboarding | ✅ Conversational voice flow | ❌ Missing | **MEDIUM** |
| Auth Pages | ✅ Login + Signup | ❌ Not visible | **LOW** |
| Customer Portal Pages | ✅ Estimate approval, invoice pay, intake | ❌ Not visible | **LOW** |
| Design Tokens / Theme | ✅ OKLCH CSS variables | ⚠️ Tailwind only | **LOW** |
| Animations | ✅ Comprehensive keyframes | ⚠️ Minimal | **LOW** |

---

## 1. Shell & Layout

### Figma (`figma-export/app/components/layout/Shell.tsx`)
- Responsive dual-sidebar architecture
- Desktop: 56px persistent left sidebar with 10 nav routes, notification bell, voice bar, camera button, user avatar/role
- Mobile: Top bar (hamburger + settings) + bottom tab bar (6 routes)
- Notification badges on nav items (4 on Assistant, 2 on Invoices, 5 on Leads)
- Smooth transitions and animations throughout

### Web
- **No shell or layout wrapper found.** Pages appear to be standalone with no persistent navigation.

### Gaps
- Complete shell layout is missing
- No desktop sidebar navigation
- No mobile bottom tab bar
- No notification badge system
- No integrated voice bar in the layout chrome

---

## 2. Home Dashboard

### Figma (`figma-export/app/components/home/HomePage.tsx`)
- Two-column responsive layout (operational left, financial/attention right)
- Personalized greeting ("Good morning, [name]")
- 3-stat pulse cards: Active today / Outstanding / Needs attention
- Today's jobs section with status, time, assigned tech
- This week strip — horizontal week navigator + job previews
- Unscheduled jobs section with dashed-border styling
- Lead pipeline widget with status breakdown
- Needs attention section (overdue invoices, follow-ups, scheduling)
- Pending estimates section
- Outstanding invoices section with financial summary
- Quick actions grid: New job / New estimate / New invoice / Schedule
- "All clear" success state when nothing needs attention

### Web
- **No home/dashboard page found.**

### Gaps
- Entire home screen is missing — this is the primary landing screen per the design brief

---

## 3. AI Assistant / Conversations

### Figma (`figma-export/app/components/assistant/AssistantPage.tsx`)
- Chat bubbles: user (dark), AI (light)
- Voice messages with waveform visualization
- Photo attachments in thread
- AI messages: proposals, timestamps, thumbs up/down reactions, copy button
- Reasoning display while typing ("Searching jobs…")
- Typing indicator with bouncing dots
- Today context strip (active jobs, pending invoice, attention items)
- 6 suggestion chips for pre-built prompts
- Voice recording bar: idle → recording (timer + live waveform) → transcribing → transcript
- Attachment picker: camera photo / document
- Auto-scroll to bottom; scroll-to-bottom button when scrolled up
- Keyboard hints (Enter to send, Shift+Enter for newline)

### Web (`packages/web/src/pages/conversations/`)
- ConversationThread, MessageBubble, SystemEvent, MessageInput components exist
- VoiceRecorder component exists
- TranscriptEditor and TranscriptMessage components exist
- Role-based permission checking in place

### Gaps
- No voice waveform visualization
- No message reactions (thumbs up/down)
- No copy button on messages
- No typing indicator
- No reasoning display during AI response
- No today context strip
- No suggestion chips
- No attachment picker UI
- No auto-scroll / scroll-to-bottom button
- Visual styling of bubbles not aligned with Figma

---

## 4. Job Detail

### Figma (`figma-export/app/components/jobs/JobDetail.tsx`)
- Status stepper showing job progression
- Job header: back button, customer name, address, map link
- Service type badge with emoji
- Assigned technician with avatar + phone/text quick actions
- Activity timeline with all job events
- Materials tracking: quantity, unit cost, total
- Modal/sheet flows: Call screen, Text sheet, Estimate/Invoice sheet, AddEntry, Materials, Suppliers, CancelNoShow
- Camera capture integration
- AI actions relevant to the job
- Quick invoice/estimate/follow-up actions

### Web (`packages/web/src/pages/jobs/JobDetail.tsx`)
- Uses generic `DetailPage` wrapper
- Only shows: jobNumber, summary, status, priority, problemDescription

### Gaps
- No status stepper
- No activity timeline
- No materials tracking
- No technician assignment UI
- No modal/sheet flows
- No AI suggestion panel
- No quick actions (call, text, invoice, estimate)
- Complete feature gap — web is a placeholder

---

## 5. Technician View

### Figma (`figma-export/app/components/jobs/TechJobView.tsx`)
- 5-stage status flow: En Route → On Site → In Progress → Waiting for Parts → Complete
- Voice parsing with HVAC parts catalog (capacitor, contactor, refrigerant, filters, etc.)
- Auto-extracts part names and quantities from voice transcripts
- Material accumulation during job (+/- quantity controls)
- Field notes (voice or typed)
- Color-coded status update CTAs
- Photo/document attachment support
- Job completion workflow

### Web (`packages/web/src/pages/technician/MobileTechView.tsx`)
- Job list + selected job detail
- VoiceRecorder integration
- TranscriptMessage component
- Minimal styling (data-testid attributes only)

### Gaps
- No voice parsing / NLP for parts extraction
- No parts catalog
- No material accumulation with +/- controls
- No 5-stage status flow UI
- No color-coded CTAs
- Significant feature gap

---

## 6. Schedule / Dispatch

### Figma (`figma-export/app/components/schedule/SchedulePage.tsx`)
- Week navigator with chevron controls
- Day selector buttons showing per-day job counts
- Technician filter pills
- Day-based job list view, time-based
- Quick "New job" button

### Web (`packages/web/src/pages/dispatch/DispatchBoard.tsx`)
- Technician-lane kanban board (different UX pattern)
- Unassigned queue sidebar
- DateNavigation, SummaryStrip, DispatchFilters, TechnicianLane, AppointmentCard components

### Gaps
- Different UX approach: Figma is a day-view list; web is a kanban lanes board
- Figma view is simpler and more mobile-friendly per the design brief
- The web dispatch board may need a companion simplified view for the "Schedule" nav entry

---

## 7. Estimates

### Figma (`figma-export/app/components/estimates/EstimatesPage.tsx`)
- List with approval stepper: Created → Sent → Viewed → Approved
- AI pricing suggestions (sentiment: ok / tip / warn with icons)
- Confidence indicator with progress bar (High/Medium)
- NewEstimateFlow multi-step modal
- ConvertToInvoiceSheet modal
- Editable line items inline

### Web (`packages/web/src/pages/estimates/EstimateList.tsx`)
- Generic ListPage wrapper
- Columns: estimateNumber, status, total
- Basic status filter + search

### Gaps
- No approval stepper visualization
- No AI pricing hints
- No confidence indicator
- No NewEstimateFlow modal
- No ConvertToInvoice sheet
- No inline line item editing

---

## 8. Invoices

### Figma (`figma-export/app/components/invoices/InvoicesPage.tsx`)
- Payment timeline stepper: Draft → Sent → Viewed → Paid
- Payment methods card (credit card, ACH, fee display)
- Overdue warning alerts
- Customer notification options (SMS / email)
- Lock icon for secure payment branding

### Web (`packages/web/src/pages/invoices/InvoiceList.tsx`)
- Generic ListPage wrapper
- Columns: invoiceNumber, status, total, amountDue
- Basic status filter

### Gaps
- No payment timeline stepper
- No payment methods UI
- No overdue alerts
- No notification options

---

## 9. Customers

### Figma (`figma-export/app/components/customers/CustomersPage.tsx`)
- Customer list with search
- Add customer multi-step sheet modal
- Service type selector (HVAC / Plumbing / Painting)
- Location management per customer
- Duplicate detection (by phone / email)
- Location service types and access codes
- Quick actions: New estimate / New job from customer

### Web (`packages/web/src/pages/customers/CustomerList.tsx`)
- Generic ListPage wrapper
- Columns: displayName, companyName, email, primaryPhone
- Filter by archived status

### Gaps
- No add customer modal
- No duplicate detection
- No location management
- No quick actions from customer
- CustomerDetail page also appears to be basic

---

## 10. Shared Components

### AIProposalCard

**Figma** (`figma-export/app/components/shared/AIProposalCard.tsx`):
- Proposal types: Invoice, Estimate, Schedule, Follow-up, Alert, Duplicate
- States: Pending (with edit) / Approved (green check) / Rejected (dismissed)
- Confidence indicator with progress bar + High/Medium label
- Fully editable fields per proposal type
- Impact tags
- Reasoning display
- Auto-applied badge (for low-risk actions)
- Full approve / edit / reject workflow

**Web** (`packages/web/src/components/conversations/ProposalCard.tsx`):
- Basic structure, minimal styling
- Role-based permission checking
- Simple approve/reject buttons

**Gaps**: No edit mode, no confidence indicator, no proposal type variants, no impact tags, no reasoning display, no auto-applied badge

---

### VoiceBar

**Figma** (`figma-export/app/components/shared/VoiceBar.tsx`):
- Desktop and mobile variants
- Phases: idle → listening → transcript → sending
- Live waveform visualization (animated bars)
- 6 demo voice commands shown
- Auto-advance through phases
- Navigation to AI thread after send

**Web**: VoiceRecorder component exists but lacks waveform animation and desktop variant.

---

### StatusBadge

**Figma** (`figma-export/app/components/shared/StatusBadge.tsx`):
- 14+ status types with colored dots
- Size variants (sm / md)
- Background toggle

**Web**: Likely implemented; needs alignment check.

---

## 11. Missing Pages (in web)

| Page | Figma File |
|---|---|
| Leads | `figma-export/app/components/leads/LeadsPage.tsx` |
| Interactions | `figma-export/app/components/interactions/InteractionsPage.tsx` |
| Settings | `figma-export/app/components/settings/SettingsPage.tsx` |
| Templates | `figma-export/app/components/settings/TemplatesPage.tsx` |
| QuickBooks modal | `figma-export/app/components/settings/QuickBooksModal.tsx` |
| Onboarding | `figma-export/app/components/onboarding/OnboardingPage.tsx` |
| Auth — Login | `figma-export/app/components/auth/LoginPage.tsx` |
| Auth — Signup | `figma-export/app/components/auth/SignupPage.tsx` |
| Customer — Estimate Approval | `figma-export/app/components/customer/EstimateApprovalPage.tsx` |
| Customer — Invoice Payment | `figma-export/app/components/customer/InvoicePaymentPage.tsx` |
| Customer — Intake Form | `figma-export/app/components/customer/IntakeFormPage.tsx` |

---

## 12. Design Tokens

**Figma** (`figma-export/styles/theme.css`):
- OKLCH color system (light + dark modes)
- Full CSS variable set: colors, typography, borders, shadows, radius
- Sidebar-specific theme variables
- Chart color tokens (5 variants)
- Font weight tokens (400, 500)
- Semantic radius tokens (sm, md, lg, xl)

**Web**: Tailwind CSS with likely custom config but no OKLCH variable system confirmed.

**Gap**: Color and spacing tokens may not be aligned. The OKLCH variables should be imported or replicated in the web Tailwind config.

---

## 13. Navigation Routes

### Figma (`figma-export/app/routes.ts`)
Desktop nav (10 items):
`/` Home, `/assistant` AI, `/jobs` Jobs, `/schedule` Schedule, `/customers` Customers, `/leads` Leads, `/estimates` Estimates, `/invoices` Invoices, `/interactions` Interactions, `/settings` Settings

Mobile bottom bar (6 items):
Home, AI, Jobs, Leads, Customers, Invoices

### Web
No persistent routing/navigation structure found.

---

## Priority Implementation Order

1. **Shell Layout** — blocks everything; add desktop sidebar + mobile bottom bar
2. **Home Dashboard** — primary landing screen per design brief
3. **Theme tokens** — import OKLCH variables into Tailwind config
4. **Job Detail** — enrich to match Figma (timeline, materials, modals)
5. **AI Proposal Card** — add confidence indicator, edit mode, proposal variants
6. **Estimates workflow** — add approval stepper, AI hints, NewEstimateFlow
7. **Invoices workflow** — add payment stepper and methods UI
8. **Customer management** — add create modal, duplicate detection, locations
9. **Technician View** — voice parsing, parts catalog, 5-stage status flow
10. **Missing pages** — Leads, Interactions, Settings, Onboarding, Auth, Customer portal
11. **Animations** — align with Figma keyframes (fadeIn, fadeSlideUp, waveBar, typingBounce)
