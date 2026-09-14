# ServiceTitan Feature Inventory (as of September 2026)

Method note: vendor and review-site pages were reachable only via search-engine summaries in this environment (direct fetches to servicetitan.com, help.servicetitan.com, G2, Capterra were blocked by the egress proxy). Every row cites the page the claim came from; rows where the summary was thin are marked "unverified".

## 1. AI phone answering / virtual receptionist / call booking

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| AI Voice Agent (Titan Intelligence) | Answers inbound calls 24/7 and books new jobs directly onto the dispatch board using real-time Adaptive Capacity availability. | Pro add-on; usage-based, reported "starting at $2.75 per call", no long-term commitment required, works with Contact Center Pro or third-party phone systems | https://www.servicetitan.com/features/pro/contact-center/voice-agents ; https://www.servicetitan.com/podcasts/mastering-servicetitan/henry-cheng-interview |
| Voice Agent: confirm / reschedule / memberships / dispatch fees | Confirms and reschedules existing appointments, recognizes membership status, and communicates dispatch/trip fees to callers. | Included in Voice Agent | https://help.servicetitan.com/v1/docs/ai-voice-agent-for-basic-phones-and-phones-pro-faq |
| Voice Agent: after-hours booking + tech notification | Books after-hours jobs and, when Dispatch Pro assigns a tech, places an outbound call and SMS to that tech with date, time, address, and job type. | Requires Dispatch Pro for the auto-assignment step | https://www.servicetitan.com/blog/webinar-recap-ai-voice-agents-call-booking |
| Voice Agent: live-agent escalation / transfer | Escalates or transfers to a live CSR when the call falls outside configured rules or needs human judgment, using configurable triggers and routing rules. | Included | https://www.servicetitan.com/features/pro/contact-center |
| Voice Agent: Spanish language | Automatically switches to Spanish when the caller speaks Spanish. | Included; other languages not documented (unverified) | https://help.servicetitan.com/release-hub/docs/handle-calls-from-spanish-speaking-customers-with-voice-agent-spanish-language-s |
| Voice Agent: objection handling, multi-agent, unbooked-call email alerts | Spring 2026 (ST-77) adds objection handling to book more calls, multiple Voice Agents per account, and email notifications for unbooked AI calls. | Spring 2026 release | https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |
| Voice Agent: quoting | No evidence found that the voice agent quotes prices beyond stating dispatch fees. | unverified | https://help.servicetitan.com/v1/docs/ai-voice-agent-for-basic-phones-and-phones-pro-faq |
| Contact Center Pro | Native (not third-party) contact-center platform combining phone, email, web and social into a universal inbox with queue management, live coaching, and AI features. | Pro add-on, pricing unpublished | https://www.servicetitan.com/features/pro/contact-center ; https://www.servicetitan.com/blog/webinar-recap-contact-center-pro |
| SMS Agent + Outbound Support | AI agent handles inbound and outbound text conversations and follows up on leads automatically (added April–June 2026). | Part of Contact Center Pro / Marketing Pro AI-powered agents | https://www.stork.ai/en/servicetitan-pro-ai-virtual-agent ; https://www.servicetitan.com/features/pro/marketing/ai-powered-agents |
| Virtual Agent Dashboard | Monitors AI agent booking rates and call-handling efficiency. | Announced for Q1 2026 (unverified GA) | https://www.stork.ai/en/servicetitan-pro-ai-virtual-agent |
| Phones Pro (VoIP + CSR productivity) | Cloud phone system integrated with ServiceTitan: call tracking, recording, booking analytics, real-time transcription, sentiment analysis. | Pro add-on; prerequisite for several AI call features | https://www.servicetitan.com/features/pro/phones |
| Second Chance Leads | AI reviews recordings of unbooked / "not a lead" / excused calls after the CSR hangs up and flags the ones most likely to be saved with a follow-up call. | Included by default with Phones Pro; requires VoiceAI transcription enabled | https://help.servicetitan.com/docs/second-chance-leads-1 ; https://help.servicetitan.com/v1/docs/set-up-second-chance-leads-for-phones-pro |

## 2. Scheduling and dispatch

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Dispatch board + technician GPS tracking | Drag-and-drop dispatch board; dispatchers (and customers, if enabled) can track tech location en route. | Core | https://help.servicetitan.com/docs/dispatch-and-track-your-technicians |
| Adaptive Capacity | Infers "natural capacity" from ServiceTitan data (tech skills, zones, job types, arrival windows) and lets you layer percentage-based strategic rules to open or throttle booking. | Core in Max/newer packages (unverified for lower tiers) | https://help.servicetitan.com/docs/capacity-planning ; https://help.servicetitan.com/docs/adaptive-capacity-faq |
| Atlas in Adaptive Capacity | Natural-language co-pilot ("decrease general capacity by 20% until March") that builds the capacity rules for you. | Winter 2026 (ST-76) | https://help.servicetitan.com/landing-page/winter-2026-release-hub ; https://www.servicetitan.com/podcasts/mastering-servicetitan/carla-lynn-interview |
| Dispatch Pro (AI auto-dispatch) | ML algorithm runs thousands of scenarios on skills, sales performance, predicted job value and proximity to auto-assign the best tech; optimize for revenue or efficiency; claims 2x capacity per dispatcher. | Pro add-on, pricing unpublished | https://www.servicetitan.com/features/pro/dispatch ; https://www.servicetitan.com/blog/webinar-recap-dispatch-pro |
| Dispatch Pro Smart Routing + max drive time | Dynamic re-routing when a tech is delayed; dispatchers can cap drive time between jobs (e.g., 30 min). | Part of Dispatch Pro | https://www.servicetitan.com/blog/top-five-tips-for-maximizing-dispatch-board-tools |
| Customer notifications (booking, reminder, dispatch, arrival, completion survey) | Automated SMS/email at each stage, with a real-time tech-tracking web link in "on my way"/arrival texts. | Core | https://help.servicetitan.com/docs/customer-notifications |
| Automated Job Confirmations | Customers confirm by replying with a keyword; job auto-marked confirmed. | Core | https://help.servicetitan.com/docs/set-up-use-auto-job-confirmations |
| Fleet Pro | Native fleet management: vehicle GPS, driver-safety monitoring, payroll reconciliation, maintenance scheduling, asset tracking; Ford Pro + Fleet Pro GA spring 2026; service entries logged from mobile. | Pro add-on | https://www.servicetitan.com/features/pro/fleet ; https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |
| Mobile calendar for techs | Techs manage their own schedule from the Field Mobile App. | Spring 2026 | https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |

## 3. Estimates / quotes

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Multi-option (Good-Better-Best) estimates | Build multiple estimate options from the pricebook in the field or office and present them side-by-side. | Core | https://www.servicetitan.com/blog/electrical-bidding-software ; https://help.servicetitan.com/docs/estimates-and-proposals-in-servicetitan-max |
| In-field e-signature approval | Customer approves and e-signs the estimate on the tech's device. | Core | https://www.servicetitan.com/blog/plumbing-pricing-app |
| Financing inside estimates | Techs attach financing plans, submit applications and get approvals on the spot via GreenSky, GoodLeap, Service Finance, Wells Fargo, Synchrony, Financeit, etc. | Core integrations; no ServiceTitan fee for GreenSky integration | https://www.servicetitan.com/blog/plumbing-pricing-app ; https://help.servicetitan.com/how-to/greensky-financing ; https://help.servicetitan.com/faq/financing-faq |
| Deposits on estimates via Customer Portal | Customers review, sign/approve proposals and pay deposits online. | Core | https://help.servicetitan.com/docs/the-new-customer-portal-end-user-experience |
| Pricebook (core) with Dynamic Pricing rules | Catalog of services/materials/equipment; Dynamic Pricing recomputes service prices from billable rates and markup tables when material costs change. | Core pricebook; Dynamic Pricing described under Pricebook Pro | https://www.servicetitan.com/blog/introducing-pricing-builder ; https://help.servicetitan.com/v1/docs/pricebook-pro |
| Pricebook Pro | Pre-built flat-rate content with images and descriptions, automated vendor cost updates, and Price Insights. | Pro add-on | https://www.servicetitan.com/features/pro/pricebook |
| Price Insights (AI benchmark pricing) | Compares your price for each service to regional averages with a confidence meter. | Part of Pricebook Pro | https://www.servicetitan.com/blog/pricebook-with-titan-intelligence |
| Convex (commercial prospecting/sales CRM) | Property intelligence, buyer-intent signals and sales engagement for commercial service agreements. | Separate product (acquired 2024) | https://www.servicetitan.com/products/convex |

## 4. Invoicing and payments

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| ServiceTitan Payments (in-house processing) | Integrated card, ACH and financing acceptance in the field and office; runs on ServiceTitan's own rails, not white-labeled Stripe. | Reported ~2.9% + $0.30 for cards; rates "vary by agreement" | https://www.servicetitan.com/features/payments ; https://merchantcostconsulting.com/lower-credit-card-processing-fees/servicetitan-review/ |
| Card readers + Tap to Pay on iPhone/NFC | Swipe/dip/tap via hardware readers, or contactless on the tech's phone with no hardware. | Included with Payments | https://www.servicetitan.com/blog/webinar-recap-optimizing-field-payment-tools |
| Pay by Bank + ACH | Customer authorizes payment via their banking app (with real-time balance check) or enters routing/account numbers. | Included with Payments | https://www.servicetitan.com/blog/webinar-recap-optimizing-field-payment-tools |
| Card surcharge / cash-discount workflow | Pricebook item adds ~3% card fee; tech can offer 3% off for ACH/Pay by Bank. | Configuration pattern, not a switch | https://www.servicetitan.com/blog/webinar-recap-optimizing-field-payment-tools |
| Next-day deposits, auto-batching | Processed payments deposited within 24 hours; auto-batching with unmatched-transaction emails; refunds not auto-batched. | Included | https://www.servicetitan.com/blog/best-invoice-app ; https://help.servicetitan.com/faq/payments-faq |
| Field invoicing + multi-invoice portal pay | Techs create/send invoices and record card/cash/check in-app; customers pay one or many invoices online. | Core | https://www.servicetitan.com/blog/contractor-invoicing-app ; https://help.servicetitan.com/docs/the-new-customer-portal-end-user-experience |
| Progress billing (AIA-style) | Continuation sheets auto-generated from project estimates and turned into pay applications per phase; consolidated project invoice on mobile (spring 2026). | Core (projects) | https://help.servicetitan.com/how-to/project-tracking-progress-billing ; https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |
| Tips / gratuity | Community threads discuss tipping techs; a gratuity prompt is described generically by a third party — no vendor documentation found. | unverified | https://community.servicetitan.com/t5/General/Tipping-Technicians/m-p/41228 ; https://fluid.services/tipping-in-appliance-repair-why-we-dont-ask/ |
| Membership recurring billing + card-updater | "Ready to Bill" queue for memberships/service agreements; optional renewal protection auto-updates card expirations. | Core | https://help.servicetitan.com/docs/process-recurring-billing-for-memberships-and-service-agreements |
| Atlas in Accounting (AI invoice review) | Flags invoices needing review, detects anomalies, recommends next steps; three-way matching in AP (Winter 2026). | Atlas; availability by package unverified | https://www.servicetitan.com/blog/webinar-recap-atlas-your-ai-sidekick ; https://help.servicetitan.com/landing-page/winter-2026-release-hub |

## 5. Customer communications

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Two-way SMS + Chat | Text customers, receive replies (confirm/reschedule/questions) inside ServiceTitan; web chat product. | Core | https://www.servicetitan.com/features/customer-experience-software ; https://www.servicetitan.com/blog/servicetitan-introduces-chat |
| Technician bio / "on my way" texts | Sends tech photo/bio and live tracking link before arrival. | Core | https://www.servicetitan.com/features/customer-experience-software |
| Marketing Pro – Email | Segmented email campaigns built from job history, equipment age, membership status; templates like "Unsold Estimates" and "Memberships Expiring"; per-campaign revenue attribution. | Pro add-on; third parties report ~$2,000+/mo (unverified) | https://www.servicetitan.com/features/pro/marketing/email ; https://projul.com/blog/servicetitan-pricing-analysis-2026/ |
| Marketing Pro – Reputation | Auto review requests via SMS/email after job completion, consolidated review feed, listing sync across 60+ sites. | Pro add-on | https://www.servicetitan.com/features/pro/marketing/reputation ; https://www.servicetitan.com/blog/marketing-pro-reputation-direct-mail |
| Marketing Pro – Direct Mail | Targeted postcards with booked-job/revenue attribution. | Pro add-on | https://www.servicetitan.com/blog/marketing-pro-reputation-direct-mail |
| Atlas in Marketing Pro (AI copy) | Drafts re-engagement email copy, revises tone/length, translates, SEO-optimizes. | Part of Marketing Pro | https://help.servicetitan.com/release-hub/docs/launch-revenue-driving-campaigns-faster-with-atlas-in-marketing-pro |
| Recurring-service SMS campaigns | Automated texts for recurring service follow-ups. | Core / Marketing Pro (unverified split) | https://help.servicetitan.com/how-to/create-recurring-service-campaigns-using-sms |
| Memberships / service agreements | Template-based residential memberships; commercial agreements with billing cadence, auto-renew, revenue recognition (immediate/deferred/straight-line), margin targets; audit trail + bulk actions (spring 2026). | Core | https://www.servicetitan.com/blog/maintenance-agreements ; https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |

## 6. CRM and leads

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Customer Portal | Branded self-service: view/pay invoices, approve estimates, see appointments, work history, memberships; self-schedule. | Core | https://www.servicetitan.com/features/customer-portal-software ; https://help.servicetitan.com/docs/customer-portal-overview |
| Scheduling Pro (online booking) | 24/7 booking widget on website/social/Google using real-time availability; collects payment and memberships at booking; agentic SMS booking; emergency call button with tracking number. | Pro add-on | https://www.servicetitan.com/features/pro/scheduling ; https://www.servicetitan.com/blog/introducing-scheduling-pro |
| Reserve with Google + Google LSA booking | "Book Online" on Maps/Search and LSA books straight into the Call Booking screen with job-type mapping. | Requires Scheduling Pro (US/Canada) | https://help.servicetitan.com/docs/google-local-service-ads-glsa-faq ; https://www.servicetitan.com/features/local-services-ads |
| Call tracking + campaign attribution | Tracking numbers per campaign, call recording, booking analytics tied to campaigns. | Phones Pro / core call tracking | https://www.servicetitan.com/features/pro/phones |
| Marketing Pro – Ads (attribution) | Syncs UTM/GCLID attribution from calls and web bookings to jobs and revenue. | Pro add-on | https://www.servicetitan.com/features/pro/marketing/ads ; https://help.servicetitan.com/docs/track-lead-attribution-and-scheduling-pro-jobs |
| Marketing Pro – Ads Optimizer | AI adjusts Google Ads budgets/bids from actual job revenue and tech availability. | Separate Pro SKU | https://help.servicetitan.com/roofing/docs/enable-marketing-pro-ads-optimizer |
| CRM: Residential | Lead/opportunity pipeline for residential sales, GA spring 2026. | Announced Pantheon 2025 | https://www.servicetitan.com/press/servicetitan-major-product-expansions-pantheon-2025 ; https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |
| Lead capture via Zapier / email | Zap books a job or task from an inbound email lead. | Beta, unsupported | https://help.servicetitan.com/how-to/book-a-job-off-an-email-lead-using-zapier-integration |

## 7. Job execution and technician app

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Field Mobile App (iOS/Android/tablet) | Job details, customer history (past estimates, equipment, invoices, photos/videos), pricebook, payments; tablet UI optimizations spring 2026. | Core | https://www.servicetitan.com/features/service-scheduling-software ; https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |
| Forms and checklists | Job/technician forms with customer signatures, service/installation checklists, SOP prompts. | Core | https://help.servicetitan.com/v1/docs/add-technician-forms-in-fma ; https://help.servicetitan.com/docs/forms |
| Photos / attachments | Attach photos to jobs, estimates and project phases. | Core | https://www.servicetitan.com/blog/electrical-bidding-software |
| Timesheets with geofencing / Flexible Timekeeping | Tracks drive, wrench, vendor-run and overtime time; auto-applied to payroll timesheets; techs view/edit and sign off in-app. | Core | https://www.servicetitan.com/features/contractor-payroll-software ; https://help.servicetitan.com/v1/docs/view-and-edit-timesheets-with-flexible-timekeeping-in-fma |
| Inventory + purchasing | Multi-warehouse and truck stock, min/max replenishment recommendations, POs sent electronically to integrated vendors, receiving updates job costing; Inventory Mobile app for POs, transfers, counts. | Core (inventory module) | https://help.servicetitan.com/faq/inventory-and-purchase-orders-faq ; https://help.servicetitan.com/docs/replenish-items-with-purchase-orders |
| Field Pro (formerly Sales Pro) | Records/transcribes tech-customer conversations, custom scorecards, AI performance summaries and coaching; Atlas + Bluon diagnostics via nameplate scan (manuals, wiring diagrams, parts for 200+ brands). | Pro add-on | https://www.servicetitan.com/features/pro/field ; https://www.servicetitan.com/blog/webinar-recap-introducing-field-pro |
| Project management on mobile | Scope project visibility and act on project jobs from the field. | Spring 2026 | https://help.servicetitan.com/release-hub/docs/spring-2026-release-hub-st-77 |

## 8. Reporting / analytics / dashboards

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Custom reports + dashboards | Build reports and dashboard modules; "hundreds of KPIs" real-time. | Custom-report creation depends on package tier | https://help.servicetitan.com/docs/reports ; https://help.servicetitan.com/how-to/how-to-custom-dashboard-report-modules |
| Benchmark Report / Benchmark+ | Industry benchmarks from opted-in Titan Intelligence data (needs 100+ jobs/period); Benchmark+ "board-ready" enterprise insights. | Benchmark+ in "Titan Package" (unverified) | https://www.servicetitan.com/blog/webinar-recap/benchmark-report ; https://www.servicetitan.com/features/titan-intelligence |
| Atlas: ask for reports in plain English | Type/speak requests to run reports, find jobs, dispatch. | Atlas | https://www.servicetitan.com/press/servicetitan-introducing-the-next-evolution-of-ai-at-pantheon-2025-keynote |
| Marketing ROI attribution | Campaign-to-job-to-revenue reporting. | Marketing Pro | https://www.servicetitan.com/features/pro/marketing/email |

## 9. Integrations and API

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| QuickBooks Online / Desktop | Near-real-time sync of invoices, payments, customers. | Core | https://marketplace.servicetitan.com/partner/quickbooks ; https://www.servicetitan.com/features/accounting/integrations |
| Sage Intacct, Xero, NetSuite, Viewpoint Vista, CSV export | AR journal entries and AP inventory bills to Xero; multi-entity sync to Intacct; Vista for construction ERP. | Core/enterprise | https://help.servicetitan.com/docs/accounting-integrations-overview ; https://help.servicetitan.com/docs/xero-integration-guide |
| Developer API v2 (developer.servicetitan.io) | REST API; tenant access approved weekly; 60 calls/sec/app/tenant, reporting API 1 same report/min/tenant. | Third parties claim API is a paid/gated add-on — unverified | https://help.servicetitan.com/roofing/docs/get-started-with-api-dev-portal-v2 ; https://help.servicetitan.com/docs/default-api-rate-limitsfor-regular-apis-and-reporting-apis ; https://supergood.ai/api-report-card/servicetitan |
| App Marketplace (Silver/Gold/Titanium partner tiers) | Certified partner apps (vendors like Lennox, financing, Reserve with Google, Payments); ~170 partnerships reported. | Free to browse | https://marketplace.servicetitan.com/ ; https://www.servicetitan.com/legal/app-marketplace-program-guide |
| Zapier | Push tasks, notes, attachments, job bookings into ServiceTitan; requires emailing integrations@servicetitan.com. | Open beta, "as is", unsupported | https://help.servicetitan.com/roofing/docs/servicetitan-zapier-integration |
| Google integrations | LSA instant booking, Reserve with Google, Google Ads attribution/optimizer. | Scheduling Pro / Marketing Pro | https://www.servicetitan.com/blog/google-local-services |
| Financing partners | GreenSky, Service Finance, Synchrony, Financeit, GoodLeap, Wells Fargo; Turns as second-look. | Included | https://help.servicetitan.com/faq/financing-faq ; https://swivl.tech/blog/servicetitan-alternatives |

## 10. AI features beyond phone

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Titan Intelligence (TI) | Umbrella brand for ServiceTitan's trades-trained AI powering Pro products. | Platform-wide | https://www.servicetitan.com/features/titan-intelligence |
| Atlas (AI sidekick) | Conversational assistant (built on LLMs incl. Google Gemini) that runs reports, finds jobs, dispatches, guides workflows, and automates accounting, capacity, marketing and field tasks; announced Pantheon Sept 2025. | Rolling out across packages; availability by tier unverified | https://www.servicetitan.com/blog/pantheon-2025-vahe-keynote-atlas ; https://help.servicetitan.com/commercial/docs/atlas-home |
| Ask Atlas in mobile | Techs get instant equipment/documentation answers with citations without calling dispatch. | Field Pro | https://www.servicetitan.com/blog/field-pro-tech-productivity |
| AI call transcripts/summaries + scorecards | Every call (CSR and tech) transcribed and summarized with coaching recommendations. | Phones Pro / Field Pro | https://www.servicetitan.com/blog/webinar-recap-introducing-field-pro |
| Dispatch AI | Dispatch Pro ML assignment; demand-based capacity via Adaptive Capacity + Atlas. | Dispatch Pro | https://www.servicetitan.com/features/pro/dispatch |
| Pricing AI | Price Insights regional benchmarks; "benchmark pricing" automation announced at Pantheon 2025. | Pricebook Pro | https://www.servicetitan.com/blog/pricebook-with-titan-intelligence |
| Marketing AI | Ads Optimizer bid/budget automation; AI email copy; SMS/Voice agents for lead follow-up. | Marketing Pro | https://www.servicetitan.com/features/pro/marketing/ai-powered-agents |
| Construction AI | Daily logs auto-filled, RFIs and change orders created automatically. | Announced Pantheon 2025 (unverified GA) | https://www.servicetitan.com/press/servicetitan-major-product-expansions-pantheon-2025 |

## 11. Pricing model and target customer

| Feature | What it does | Tier / add-on / pricing note | Source URL |
|---|---|---|---|
| Three base tiers: Starter / Essentials / The Works | Per-technician monthly subscription; Starter = scheduling/dispatch basics, Essentials adds CRM/reporting/integrations, Works = full suite. | No published prices; third-party estimates ~$245 / ~$345 / ~$475–500+ per tech/month | https://www.servicetitan.com/pricing ; https://projul.com/blog/servicetitan-pricing-analysis-2026/ ; https://tooleduppro.com/guides/servicetitan-pricing/ |
| Implementation / onboarding fee | One-time setup and data migration, 2–12 months. | Reported $5,000–$50,000+ | https://projul.com/blog/servicetitan-pricing-analysis-2026/ |
| Contract terms | 12-month minimum, auto-renew, multi-year common for larger accounts. | Reported early-termination penalties | https://www.getonecrew.com/post/servicetitan-reviews |
| Pro add-ons | Marketing Pro, Phones Pro, Scheduling Pro, Pricebook Pro, Dispatch Pro, Fleet Pro, Contact Center Pro, Field Pro, Ads Optimizer, Convex each priced separately; users report +30–50% on the bill. | Unpublished; 2026 promo required $500+ minimum monthly value for a new Pro product | https://www.servicetitan.com/pro-offer ; https://procured.us/articles/servicetitan-pricing |
| Max Program | Bundles all Pro products with dedicated success managers under unified pricing. | Announced Pantheon 2025; cited in earnings as scaling | https://www.servicetitan.com/press/servicetitan-major-product-expansions-pantheon-2025 ; https://seekingalpha.com/news/4528789-servicetitan-outlines-244m-246m-q4-revenue-target-as-ai-led-max-program-scales |
| Target customer | Residential and commercial HVAC/plumbing/electrical (plus roofing, garage, landscaping, pest, pool); practical floor ~10 techs / ~$3M revenue; ~8,000 active customers averaging ~$78K/yr, with >$100K accounts >50% of billings. | Mid-market to enterprise | https://www.rivetops.io/servicetitan-pricing ; https://sacra.com/c/servicetitan/ |

## Common complaints (G2 / Capterra / Reddit / BBB, 2025–2026)

| Complaint | Detail | Source URL |
|---|---|---|
| Cost and per-tech pricing creep | Base $245–500/tech/month plus add-ons; Reddit case of bill rising from ~$3K to ~$10K/month at Feb 2026 renewal; Capterra "Value for Money" 3.8/5 vs 4.3 overall. | https://www.getonecrew.com/post/servicetitan-reviews ; https://fieldcamp.ai/reviews/servicetitan/ ; https://www.capterra.com/p/150053/ServiceTitan/reviews/ |
| Contract lock-in, auto-renewal, termination fees, data export | 12-month+ auto-renewing terms, BBB complaint documenting a $39,375 termination fee, difficulty exporting data on exit. | https://myquoteiq.com/servicetitan-pricing/ ; https://projul.com/blog/servicetitan-pricing-analysis-2026/ |
| Slow / inconsistent support | Tickets "dragging on for weeks", repeated escalations, hard to reach a live rep. | https://www.g2.com/products/servicetitan/reviews ; https://www.capterra.com/p/150053/ServiceTitan/reviews/ |
| Steep learning curve and long onboarding | Most-cited limitation in G2 AI summary (20+ reviews); 2–4 weeks for office, months for techs; some report never being fully onboarded while paying. | https://www.g2.com/products/servicetitan/reviews?qs=pros-and-cons ; https://fieldcamp.ai/reviews/servicetitan/ |
| Mobile app glitches after updates | App crashes/freezes mid-job, PO editing painful, battery drain, feature gaps vs desktop, frequent releases introduce bugs. | https://www.capterra.com/p/150053/ServiceTitan/reviews/ ; https://www.getonecrew.com/post/servicetitan-reviews |
| Overkill for small shops | Built for companies with departments; 6-person shops report poor fit. | https://fieldcamp.ai/reviews/servicetitan/ |
