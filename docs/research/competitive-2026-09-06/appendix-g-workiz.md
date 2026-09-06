# Workiz Feature Inventory (as of September 2026)

Research notes: Direct page fetches to workiz.com, help.workiz.com, developer.workiz.com, G2, Capterra, Trustpilot, and BBB were blocked by the network egress proxy, so every row below is based on search-engine summaries of those pages, not full page reads. Figures marked "unverified" or attributed to third-party review sites should be confirmed against the vendor before use. Workiz's public pricing page as of mid-2026 shows Standard / Pro / Ultimate behind "Request pricing" with no dollar figures; all dollar figures come from third-party sources.

## 1. AI phone answering / virtual receptionist (Genius Answering, "Jessica")

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Genius Answering (AI agent "Jessica") | AI answers inbound calls, texts, and emails, holds live conversations, and books jobs 24/7 into the Workiz schedule. | Paid add-on; third parties estimate ~$200/mo on top of Workiz Phone (~$100/mo); vendor does not publish the price. Reviewers say AI answering is gated to Pro and up. | https://www.workiz.com/features/genius-answering/ ; https://www.usecarly.com/blog/workiz-ai/ |
| Availability-aware job booking | Books directly onto the dispatch board using real technician availability; average booking time ~2 minutes per call. | Included in Genius Answering | https://www.workiz.com/ai-genius-answering/ |
| Caller identification from CRM | Recognizes returning callers from Workiz client history before the conversation starts. | Included | https://www.usecarly.com/blog/workiz-ai/ |
| Configurable qualifying questions | Asks business-configured intake questions before booking. | Included | https://www.usecarly.com/blog/workiz-ai/ |
| Auto-trained on account data | Trained from the account's services, job types, and settings, no manual script building; vendor claims training on "tens of millions" of service calls. | Included | https://www.workiz.com/ai-genius-answering/ |
| Answer-mode rules (after-hours / missed / by ad source) | Can be set to answer only after hours, only missed calls, or only calls from specific tracking numbers/ad sources. | Included; configured in settings | https://help.workiz.com/hc/en-us/articles/28907946434321-Customizing-your-Genius-Answering-settings |
| Rescheduling by callers | Lets existing customers reschedule upcoming jobs within policies you set. | Included | https://help.workiz.com/hc/en-us/articles/22777577796241-Genius-AI-overview |
| Service and pricing Q&A | Answers questions about services and pricing from account data. | Included (exact "quote" capability beyond stated prices: unverified) | https://help.workiz.com/hc/en-us/articles/30176041143697-Genius-Answering-FAQ |
| Live transfer to human | Caller can say "representative/human/agent" (or ask for a named team member) and be transferred to a number you specify. | Included; configured per account | https://help.workiz.com/hc/en-us/articles/38484381491857-Transferring-Genius-Answering-calls-to-your-team |
| Post-call summary + recording | Texts owner a summary and the call recording after each AI-handled call. | Included | https://www.usecarly.com/blog/workiz-ai/ |
| Automated follow-up after AI calls | AI-answered calls count as answered calls and trigger automation rules (e.g., follow-up text/email). | Included; uses Automations | https://help.workiz.com/hc/en-us/articles/40269859333521-Automating-follow-up-texts-and-emails-after-Genius-Answering-calls |
| Languages | English, Spanish, and French; Spanish must be enabled in settings. | Included | https://help.workiz.com/hc/en-us/articles/30176041143697-Genius-Answering-FAQ ; https://www.usecarly.com/blog/workiz-ai/ |
| Concurrent calls ("agents") | Multiple simultaneous inbound calls; a plan with 3 agents handles 3 calls at once. | Priced per agent (unverified) | https://help.workiz.com/hc/en-us/articles/30176041143697-Genius-Answering-FAQ |
| Reported booking lift | Vendor cites 15-25% lift in job booking from AI-handled after-hours calls. | Marketing claim | https://contractortoolstack.com/software/workiz/ |

## 2. Built-in phone system and call tracking (Workiz Phone)

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Workiz Phone (VoIP) | Built-in business phone system with dialer inside the web app and mobile app; calls logged to client/job records. | Add-on; third parties estimate ~$100/mo | https://help.workiz.com/hc/en-us/articles/18055851595921-What-is-Workiz-Phone ; https://tooleduppro.com/guides/workiz-pricing/ |
| Call recording | Records inbound/outbound calls (default on for outbound via dialer; inbound via call flows/masking); recordings stored on the job and client page. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/18054386076945-How-to-enable-call-recording |
| Call flows (IVR / routing) | Multi-step routing rules for inbound calls (ring team members, external numbers, voicemail); flow stops if an external number's voicemail answers. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/28122664865297-Workiz-Phone-FAQ |
| Call masking | Techs call clients from the app and the business number (not the tech's cell) is displayed. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/28122664865297-Workiz-Phone-FAQ |
| Call tracking numbers / ad-source attribution | Unique number per ad group (Google, Yelp, Facebook, etc.); jobs booked, conversion rate, and revenue auto-attributed to the ad source. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/18055833470481-Using-call-tracking-to-monitor-ad-performance ; https://www.workiz.com/features/ad-and-source-tracking/ |
| Call Tracking Report | Report of total jobs booked and call-to-job conversion rate by tracking number. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/18055833470481-Using-call-tracking-to-monitor-ad-performance |
| Book job from live call | Create a job/lead directly from the incoming call screen. | Included with Workiz Phone | https://help.workiz.com/hc/en-us/articles/18054344085265-Booking-new-jobs-directly-from-calls-on-Workiz-Phone |
| AI call summaries and search | Every call recorded, summarized, and searchable; dispatcher performance/win-rate insights. | Requires Genius AI / Call Insights (see area 11) | https://www.workiz.com/features/phone-system/ |
| Number porting in/out | Existing numbers can be ported into Workiz; port-out is documented but users report multi-month delays (see complaints). | Included | https://help.workiz.com/hc/en-us/articles/18055845562385-Porting-your-existing-phone-number-to-Workiz ; https://help.workiz.com/hc/en-us/articles/44521076396433-Porting-your-phone-number-out-of-Workiz |

## 3. Scheduling and dispatch

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Drag-and-drop schedule / dispatch board | Calendar and board views to create, move, and assign jobs; real-time job status. | All paid plans (Lite capped at 20 jobs/mo, per third parties) | https://www.workiz.com/features/job-scheduling/ ; https://www.workiz.com/features/job-status/ |
| Skill and service-area filtering | Dispatcher filters techs by skills and assigned service areas so only qualified, in-zone techs are offered. | Service areas reported as Standard and up | https://help.workiz.com/hc/en-us/articles/18055816452881-Filtering-field-techs-for-jobs-using-skills-and-service-areas ; https://www.workiz.com/features/service-areas/ |
| Live team map / GPS location tracking | Map page shows tech locations and availability designation for nearest-tech dispatching. | Location tracking reported as Standard and up | https://help.workiz.com/hc/en-us/articles/18055856754833-Tracking-your-team-s-location-in-Workiz ; https://www.workiz.com/features/dispatching/ |
| Route planning | Vendor markets routing/optimized routes via GPS and mapping integration; at least one 2026 reviewer says there is no native multi-stop route optimizer. | Conflicting; unverified | https://www.workiz.com/features/route-planning/ ; https://tooleduppro.com/reviews/workiz/ |
| Genius Scheduling (AI slot suggestions) | Suggests best time slots based on proximity to existing jobs/leads, tech availability, and drive time; used by both dispatchers and the AI answering agent. | Part of Genius suite; reported Pro and up | https://help.workiz.com/hc/en-us/articles/28421142814737-Optimizing-your-calendar-with-Genius-Scheduling |
| "On my way" and appointment reminder texts | Customizable automated SMS for reminders and tech en-route notifications. | Included | https://www.workiz.com/features/dispatching/ |
| Service Plans (recurring visits / memberships) | Templates for recurring maintenance; visits auto-generated as placeholders, converted to jobs; 14-day-ahead reminder automation; card on file auto-billing. | Feature Center add-on (unverified whether extra cost) | https://www.workiz.com/features/service-plans/ ; https://help.workiz.com/hc/en-us/articles/18053140845457-Managing-recurring-work-with-Service-Plans |
| Subcontractor scheduling | Assign jobs to subcontractors with limited dashboard access and in-app messaging. | No extra cost per vendor | https://www.workiz.com/features/sub-contractors/ |

## 4. Estimates

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Estimates with online approval | Send estimate by email/SMS; client views and approves in the client portal. | All paid plans (Lite caps estimates at 20/mo per third parties) | https://help.workiz.com/hc/en-us/articles/18055912006417-How-to-create-and-send-estimates |
| Required e-signature | Estimates approved through the client portal require a signature; approval is impossible without one. | Included | https://help.workiz.com/hc/en-us/articles/18053159710737-Collecting-client-signatures |
| Deposits on estimates | Request a fixed or percentage deposit; can be required before approval or made optional (approve now, pay later). | Requires Workiz Pay | https://help.workiz.com/hc/en-us/articles/18055843100945-How-to-request-deposits-from-clients ; https://help.workiz.com/hc/en-us/articles/39983789322001-Making-estimate-deposits-optional |
| Sales Proposals (Good / Better / Best) | Present multiple tiered estimates in one proposal with reusable templates; client picks one in the portal. | Feature Center add-on | https://www.workiz.com/features/sales-proposals/ ; https://help.workiz.com/hc/en-us/articles/18054428614801-Using-sales-proposals-to-increase-your-average-job-revenue-good-better-best |
| Financing offers on estimates | Wisetack/Sunbit pay-over-time options shown automatically on qualifying estimates. | Requires financing partner enrollment | https://help.workiz.com/hc/en-us/articles/24689191447313-Closing-larger-jobs-using-pay-over-time-options-from-Wisetack |
| Draft preview | Preview estimates/invoices as the client will see them before sending. | Included | https://help.workiz.com/hc/en-us/articles/29046669447825-Previewing-draft-estimates-and-invoices-before-sending-to-clients |
| Estimate-view notifications | Owner notified when a client views an estimate or signs a proposal. | Included | https://www.workiz.com/features/client-crm/ |

## 5. Invoicing and payments (Workiz Pay)

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Invoicing | Create/send invoices from jobs; pay-online link in client portal; overdue reminders via automations. | All paid plans (Lite capped at 20/mo per third parties) | https://help.workiz.com/hc/en-us/articles/18055818794769-How-to-create-and-send-invoices |
| Workiz Pay (integrated card processing) | Online card payments on estimates/invoices; rates shown in the Workiz Pay dashboard (card rate not published publicly). | Rates unverified; card funds in ~3-4 business days | https://www.workiz.com/features/workiz-pay/ ; https://help.workiz.com/hc/en-us/articles/18054435740817-Workiz-Pay-FAQ |
| Bank transfer (ACH) | Client pays from a bank account; US only; minimum $20; funds in 6-8 business days. | 1% processing fee | https://help.workiz.com/hc/en-us/articles/18053157573521-Bank-transfer-ACH-FAQ ; https://help.workiz.com/hc/en-us/articles/18053122621329-Understanding-bank-transfers-ACH |
| Tap to Pay on iPhone | Accept contactless cards/wallets on the tech's iPhone with no hardware. | No extra cost; qualifies for card-reader rate | https://help.workiz.com/hc/en-us/articles/18053005346193-Tap-to-Pay-on-iPhone-FAQ |
| Card readers | Physical readers for in-person card-present rate. | Hardware purchase (price unverified) | https://help.workiz.com/en/articles/6349774-collecting-payments-with-card-readers-using-workiz-pay |
| Service fee / surcharge on card payments | Pass a service fee to clients paying by card to offset processing costs. | Included with Workiz Pay | https://help.workiz.com/hc/en-us/articles/18053129593617-Charging-service-fees-for-card-payments |
| Workiz Card | Business card for Workiz Pay merchants with no monthly or card fees. | Free with Workiz Pay | https://help.workiz.com/hc/en-us/articles/18054435740817-Workiz-Pay-FAQ |
| Wisetack consumer financing | Pay-over-time offers auto-presented on estimates/invoices $500-$25,000 (up to $65,000 for qualifying accounts); 3-month 0% APR built in, 6/12/24-month 0% add-ons; merchant paid in 1-3 business days. | No setup fee; merchant fees from 3.9% | https://help.workiz.com/hc/en-us/articles/24689265610897-Wisetack-FAQ |
| Sunbit consumer financing | BNPL installments for $60-$10,000 services, 3-24 months, soft credit check, ~90% approval, ~30-second decisions. | Partner enrollment required | https://help.workiz.com/hc/en-us/articles/18054412074257-Using-Sunbit-to-offer-stress-free-financing-options-to-your-clients |
| Consumer Financing report | Tracks Wisetack loan offers sent, approved, and funded. | Included | https://help.workiz.com/hc/en-us/articles/35136765218961-Tracking-your-Wisetack-loan-offers-in-the-Consumer-Financing-report |
| Card-on-file recurring billing | Service plan subscriptions auto-charge saved cards on the chosen cadence. | Requires Workiz Pay | https://help.workiz.com/hc/en-us/articles/18053120988049-Managing-service-plan-subscriptions |

## 6. Customer communications

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Message Center (two-way SMS and email) | Unified inbox for client texts and emails tied to job/client records. | Included; SMS volume caps by plan unverified | https://help.workiz.com/hc/en-us/articles/18054341156625-Workiz-Message-Center-overview |
| Automations ("when X, do Y") | Rule builder for triggers like job status change, invoice due, call answered, sending SMS/email/notifications. | Included; reviewers say Ultimate has higher automation limits | https://help.workiz.com/hc/en-us/articles/18054429490577-Automate-your-essential-business-tasks-with-Workiz-Automations ; https://www.workiz.com/features/automations/ |
| Appointment reminders and on-my-way texts | Automated reminders before visits and en-route notifications. | Included | https://www.workiz.com/features/dispatching/ |
| Review request automation | Auto-send review link when a job closes; can filter by client tag, job type, or service area. | Included | https://help.workiz.com/hc/en-us/articles/18053045603985-How-to-increase-your-customer-reviews |
| Client portal | Client views/approves/signs/pays estimates and invoices, sees upcoming and past jobs (date, service, location, tech), documents, and payment history; pay in bulk. | Included | https://help.workiz.com/hc/en-us/articles/18053130715921-Workiz-client-portal-overview ; https://www.workiz.com/features/client-portal/ |
| Template messages | Editable message templates for estimates, invoices, and proposals. | Included | https://help.workiz.com/hc/en-us/articles/18054330472721-Editing-the-template-messages-sent-with-estimates-invoices-and-sales-proposals |
| Genius Marketing (email/SMS campaigns) | One-off and multi-step email/text campaigns with delays and conditional branching; AI builds the campaign from a description; trade-specific templates (spring tune-ups, unsold estimates); reputation management; "click-to-cash" revenue attribution. | Paid add-on (price unverified); launched 2026 | https://www.workiz.com/features/genius-marketing/ ; https://help.workiz.com/hc/en-us/articles/44412835996177-Genius-Marketing-FAQ ; https://www.prnewswire.com/news-releases/workiz-unveils-the-industrys-first-service-revenue-machine-completes-platform-with-launch-of-genius-marketing-302809288.html |
| Smart Messaging (AI drafts) | AI composes context-aware replies, suggests responses, and rewrites messages more professionally. | Genius suite | https://help.workiz.com/hc/en-us/articles/22743305605905-Transforming-your-interactions-with-AI-powered-Smart-Messaging |

## 7. CRM and leads

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Client CRM | Client records with job, estimate, invoice, payment, and communication history; tags; custom fields. | Included | https://www.workiz.com/features/client-crm/ |
| Lead Manager | Create leads, track through custom pipeline statuses, convert to jobs with data carried over. | Included | https://www.workiz.com/features/lead-management/ ; https://help.workiz.com/hc/en-us/articles/18054365163665-How-to-manage-new-leads |
| Lost-lead tracking and Leads report | Mark leads lost with reasons; Leads report filters by status, tech, creator, tag, job type, ad source, service area, external company, period. | Included | https://help.workiz.com/hc/en-us/articles/18054343282193-Marking-leads-as-lost ; https://help.workiz.com/hc/en-us/articles/19489054181393-Understanding-the-Leads-report |
| Online Booking widget / hosted page | Customers self-book via website widget, Workiz-hosted page, social links; unique booking links per channel for attribution. | Included (plan gating unverified) | https://www.workiz.com/features/online-booking/ |
| Reserve with Google / Local Services Ads booking | Jobs booked from Google LSA listing land in Message Center and schedule automatically. | Free for all accounts | https://help.workiz.com/hc/en-us/articles/18054413410065-Boosting-your-bookings-with-Google-s-Local-Services-Ads ; https://www.workiz.com/integrations/google-local-services/ |
| Ad & Source Tracking | Tag every lead/job with its source; revenue and conversion per source. | Included | https://www.workiz.com/features/ad-and-source-tracking/ |
| Genius Leads (AI lead parsing) | Extracts lead data from inbound lead emails (any source) and creates a trackable Workiz lead automatically. | Genius suite | https://www.workiz.com/blog/workiz-genius-transforms-field-service-with-ai/ |
| Franchises / multi-location | HQ admin works across child and grandchild sub-accounts with one paid seat; standardized settings and cross-location performance monitoring. | Franchises add-on (price unverified) | https://help.workiz.com/hc/en-us/articles/18055815779217-Managing-multi-location-franchise-businesses-in-Workiz |
| Custom fields | Add fields to jobs, leads, clients, invoices, equipment (gate codes, pet info, etc.). | Included | https://www.workiz.com/features/custom-fields/ |

## 8. Job execution and mobile app

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Mobile app (iOS / Android) | Techs receive jobs, update status, add notes and photos, call/text, take payment; near feature parity with desktop per reviewers. | Included; Android rated ~3.0/5 vs iOS ~4.0/5 | https://www.workiz.com/features/mobile-app/ ; https://play.google.com/store/apps/details?id=com.workiz&hl=en |
| Offline mode | App works offline and syncs when reconnected. | Included (per third-party review) | https://connecteam.com/reviews/workiz/ |
| Checklists | Custom per-job-type checklists techs complete on site. | Included | https://www.workiz.com/features/checklists/ |
| Job photos and documentation | Photo capture attached to jobs; CompanyCam integration for timestamped project photos. | Included; CompanyCam separate subscription | https://www.workiz.com/integrations/companycam/ |
| Job clock in/out (time tracking) | Per-job clock in/out records time on site; separate from shift timesheets. | Included | https://help.workiz.com/en/articles/3511970-the-difference-between-the-job-time-tracking-feature-and-time-sheets-in-workiz |
| Timesheets | Shift-level clock for office staff and general workers; a user cannot be on a timesheet and a job clock simultaneously. | Included | https://help.workiz.com/en/articles/3511970-the-difference-between-the-job-time-tracking-feature-and-time-sheets-in-workiz |
| Price book | Catalog of items/services with descriptions; add to jobs, estimates, invoices from mobile. | Included | https://help.workiz.com/hc/en-us/articles/18053094087953-Adding-items-from-your-price-book |
| Inventory management | Stock levels by location (warehouse, vehicle, office), live sync when techs adjust on the job, low-stock alerts. | Inventory add-on (price unverified) | https://www.workiz.com/features/inventory-management/ ; https://help.workiz.com/hc/en-us/articles/18055925809553-How-to-create-and-manage-inventory-locations |
| Purchase orders | Create/send POs to vendors, link to price book items and jobs, track status to delivery. | Included with inventory (unverified) | https://www.workiz.com/features/purchase-orders/ |
| Subcontractor access | Limited-permission logins for subs; in-app messaging. | No extra cost | https://www.workiz.com/features/sub-contractors/ |
| Client signatures on mobile | Capture signatures on estimates/invoices in the app. | Included | https://help.workiz.com/hc/en-us/articles/18053159710737-Collecting-client-signatures |

## 9. Reporting and analytics

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Dashboard | Widgets for sales, invoices, jobs, technician performance; show/hide widgets; permission-limited visibility. | Included | https://help.workiz.com/hc/en-us/articles/18054340308113-Workiz-dashboard-overview |
| Reports (jobs, revenue, techs, leads, ad sources) | Custom reports from jobs, invoices, estimates, timesheets: revenue by service line, tech completion rates, time on site, upsells, cancellation rates, marketing ROI. | Included; advanced/custom reports gated by plan (unverified) | https://www.workiz.com/features/reporting/ ; https://www.workiz.com/features/reports/ |
| Call Tracking Report | Jobs booked and conversion rate per tracking number. | Requires Workiz Phone | https://help.workiz.com/hc/en-us/articles/18055833470481-Using-call-tracking-to-monitor-ad-performance |
| Consumer Financing report | Wisetack offer/approval/funding tracking. | Included | https://help.workiz.com/hc/en-us/articles/35136765218961-Tracking-your-Wisetack-loan-offers-in-the-Consumer-Financing-report |
| Genius Marketing revenue attribution | Campaign-to-booked-job-to-dollars reporting. | Genius Marketing add-on | https://www.workiz.com/features/genius-marketing/ |

## 10. Integrations and API

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| QuickBooks Online | Two-way sync of invoices, payments, expenses, taxes, clients. | Reported Standard and up | https://www.workiz.com/integrations/quickbooks/ ; https://help.workiz.com/hc/en-us/articles/18055806592145-Connecting-your-QuickBooks-Online-account-to-Workiz |
| QuickBooks Desktop | Sync via Web Connector; requires QBD 2022+; sync-on-creation requires Workiz Pay. | Included where QBO is | https://help.workiz.com/hc/en-us/articles/33040652195729-Connecting-your-QuickBooks-Desktop-account-to-Workiz |
| Zapier | Triggers/actions to 5,000+ apps (e.g., new job created). | Included; Zapier plan separate | https://help.workiz.com/hc/en-us/sections/18044196596113-General ; https://zapier.com/apps/quickbooks/integrations/workiz |
| Make (community app) and Pipedream | Third-party connectors using the Workiz API (new-job webhook, etc.). | Third-party | https://apps.make.com/workiz-qjn6e1 ; https://pipedream.com/apps/workiz/integrations/http/send-post-request-with-http-webhook-api-on-new-job-created-from-workiz-api-int_GjsMLmrA |
| Google Local Services Ads / Reserve with Google | LSA bookings auto-create jobs. | Free | https://www.workiz.com/integrations/google-local-services/ |
| Thumbtack leads | Leads auto-imported into the CRM the moment they hit the Thumbtack inbox. | Included | https://www.workiz.com/integrations/thumbtack/ |
| Angi Leads | Angi leads flow into the unified Lead Manager. | Included | https://www.workiz.com/integrations/angi-leads/ |
| Yelp | Reply to Yelp leads from Workiz. | Included | https://www.workiz.com/integrations/ |
| Google Calendar / G Suite | Job sync to Google Calendar. | Included | https://www.workiz.com/integrations/g-suite/ |
| CompanyCam | Photo/project sync. | Separate CompanyCam subscription | https://www.workiz.com/integrations/companycam/ |
| Dispatch.me | Third-party-network job ingestion (e.g., warranty/home-service networks). | Included (unverified) | https://www.workiz.com/integrations/dispatch-me/ |
| Wisetack, Sunbit | Consumer financing partners (see area 5). | Partner fees | https://help.workiz.com/hc/en-us/sections/18044234642193-Consumer-financing-options-Sunbit-and-Wisetack |
| Developer API | REST API with token + secret auth, enabled from the Feature Center; webhooks; docs at developer.workiz.com. Endpoint breadth (jobs, leads, clients) and rate limits: unverified. | Toggle in Feature Center; plan gating unverified | https://developer.workiz.com/ ; https://apitracker.io/a/workiz |
| Mailchimp, Stripe, Outlook, Zoom | Listed by review aggregators; direct native integration status unverified. | Unverified | https://sourceforge.net/software/product/Workiz/integrations/ |

## 11. AI features beyond phone answering (Genius suite)

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Call Insights | Transcribes and summarizes recorded calls, highlights key moments, flags concerns and upsell opportunities, suggests follow-ups, and surfaces training/coaching areas. | Genius suite; requires Workiz Phone | https://www.workiz.com/blog/workiz-genius-transforms-field-service-with-ai/ ; https://www.workiz.com/features/phone-system/ |
| Smart Messaging | AI-drafted replies, suggested responses, tone rewrites in Message Center; vendor claims 55% faster workflows. | Genius suite | https://help.workiz.com/hc/en-us/articles/22743305605905-Transforming-your-interactions-with-AI-powered-Smart-Messaging |
| Genius Leads | Parses lead emails from any source into structured Workiz leads. | Genius suite | https://www.workiz.com/features/workiz-genius/ |
| Genius Scheduling | AI slot suggestions minimizing drive time (see area 3). | Genius suite; reported Pro+ | https://help.workiz.com/hc/en-us/articles/28421142814737-Optimizing-your-calendar-with-Genius-Scheduling |
| Genius Marketing AI Campaign Engine | Autonomously generates trade-specific outreach and follow-up sequences from job history, tags, and last-service dates. | Paid add-on | https://aijourn.com/workiz-unveils-the-industrys-first-service-revenue-machine-completes-platform-with-launch-of-genius-marketing/ |
| Dispatcher performance insights | AI-derived win rates, missed opportunities, and dispatcher scoring from call data. | Genius suite | https://www.workiz.com/features/phone-system/ |
| Genius launch | "Genius" AI offering announced March 2024; vendor claims 33% lower response time and 45% higher reported satisfaction. | Marketing claim | https://www.prnewswire.com/news-releases/workiz-launches-genius-to-revolutionize-field-service-management-with-ai-powered-offering-302088161.html |

## 12. Pricing tiers and target customer

| Item | What it is | Pricing note | Source URL |
|---|---|---|---|
| Public pricing page (mid-2026) | Three plans, Standard / Pro / Ultimate, all "Request pricing"; 7-day trial; free plan no longer listed. | No public dollar figures | https://toolberry.net/en/blog/workiz-doesn-t-list-a-free-plan-anymore-here-s-what-to-do-if-that-was-your-plan/ ; https://www.workiz.com/pricing-plans/ |
| Lite (legacy free plan) | Up to 2 users; 20 jobs/invoices/estimates per month cap. | Free; may no longer be offered | https://www.trustradius.com/products/workiz/pricing ; https://checkthat.ai/brands/workiz/pricing |
| Kickstart / Standard / Pro (third-party figures) | Third parties cite ~$187 / $229 / $270 per month annual (~$225 / $275 / $325 monthly) for up to 5 users; extra users $46-$55 (Standard) and $54-$65 (Pro). | Unverified; varies by source | https://tooleduppro.com/guides/workiz-pricing/ ; https://www.workiz.com/pricing-plans-meteor/ |
| Per-user figures (alternate) | Another source lists Standard ~$65/user/mo and Ultimate ~$120/user/mo. | Unverified | https://hvacsoftwarehub.com/hvac/pricing/workiz-pricing/ |
| Tier gating summary | Standard adds location tracking, service areas, QuickBooks; Pro adds AI scheduling and AI answering; Ultimate adds higher automation limits and tailored support. | Per third-party reviews | https://serviceagent.ai/blogs/workiz-pricing/ |
| Add-on costs | Workiz Phone ~$100/mo; Genius Answering ~$200/mo; other modules cited at $200-$300/mo each. | Unverified; vendor does not publish | https://tooleduppro.com/guides/workiz-pricing/ ; https://www.usecarly.com/blog/workiz-ai/ |
| Target customer | Small on-demand home-service businesses, roughly 1-20 employees, in locksmith, garage door, appliance repair, junk removal, HVAC, plumbing, electrical, cleaning; 96% of reviewers from small companies. | - | https://fieldserviceguide.com/workiz/ ; https://www.capterra.com/p/147525/Workiz/ |
| Scale claims | 120,000+ field service pros across 5,000+ organizations. | Vendor claim | https://contractortoolstack.com/software/workiz/ |

## Common customer complaints (2025-2026)

| Complaint | Detail | Source URL |
|---|---|---|
| Android app reliability and lag | Android app rated ~3.0/5 on Google Play versus ~4.0/5 iOS; recurring lag/crash reports; reviewers call it a dealbreaker for Android-first crews. | https://tooleduppro.com/reviews/workiz/ ; https://play.google.com/store/apps/details?id=com.workiz&hl=en_CA&gl=US |
| Add-on cost stacking / hidden fees | Base plan plus phone plus AI answering plus other modules ($200-$300/mo each) makes total cost far above the headline; Capterra tags "Expensive" and "Pricing Issues." | https://tooleduppro.com/reviews/workiz/ ; https://www.capterra.com/p/147525/Workiz/reviews/ |
| Billing and cancellation practices | Trustpilot 3.1/5 (126 reviews): continued charges after cancellation, hidden cancel option, annual contracts enforced, refunds promised but not delivered. | https://www.trustpilot.com/review/workiz.com ; https://www.bbb.org/us/ca/san-diego/profile/project-management-software/workiz-1126-1000078555/complaints |
| Phone number port-out delays | BBB complaints of 3+ month delays porting numbers out (Dec 2025 - Mar 2026), no port-out PINs or timelines, "still in progress" responses. | https://www.bbb.org/us/ca/san-diego/profile/project-management-software/workiz-1126-1000078555/complaints |
| Slow or unresponsive support; phone system glitches | Reviews cite week-plus waits for support callbacks; calls arriving with hold music and no caller; app dialer not connecting to wireless headphones; support saying "nothing is wrong." | https://www.softwareadvice.com/field-service/workiz-profile/reviews/ ; https://www.capterra.com/p/147525/Workiz/reviews/?page=2 |

Overall ratings for context: G2 4.6/5; Capterra 4.4/5 (218 reviews); Trustpilot 3.1/5. Sources: https://www.g2.com/products/workiz/reviews ; https://www.capterra.com/p/147525/Workiz/reviews/ ; https://www.trustpilot.com/review/workiz.com
