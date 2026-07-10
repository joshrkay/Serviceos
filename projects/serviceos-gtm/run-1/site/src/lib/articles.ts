/**
 * Typed article data module powering /resources and /resources/[slug].
 * Body is an ordered list of simple blocks rendered to HTML by the template
 * (no MDX toolchain needed). Inline text supports a minimal `[label](url)`
 * markdown-link syntax, parsed by the template — this is how sourced facts
 * and internal links render as real anchors without a heavier content pipeline.
 *
 * Every external number and every competitor claim in this file traces to a
 * URL in /projects/serviceos-gtm/run-1/research/sources.md. Every Rivet
 * capability claim traces to a ✅ row in /projects/serviceos-gtm/run-1/claims.md.
 * Nothing here claims MMS/photo-to-quote, ACH, or B2B/property-manager
 * routing as shipped — those are explicitly banned in claims.md.
 */

export type ArticleBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { kind: 'faq'; items: { question: string; answer: string }[] }
  | { kind: 'cta'; heading: string; text: string; href: string; label: string };

export interface Article {
  slug: string;
  title: string;
  description: string;
  category: string;
  /** ISO date. */
  publishedAt: string;
  readingMinutes: number;
  author: string;
  /** Primary search query this article targets. */
  targetQuery?: string;
  /** Curated related-article slugs, shown instead of the default "most recent" pick. */
  relatedSlugs?: string[];
  body: ArticleBlock[];
}

export const ARTICLES: Article[] = [
  // ---------------------------------------------------------------------
  // 1. Jobber-alternative cluster
  // ---------------------------------------------------------------------
  {
    slug: 'jobber-vs-rivet-who-does-the-paperwork',
    title: 'Jobber vs. Rivet: Who Actually Does the Paperwork?',
    description:
      "Jobber organizes your paperwork. Rivet's AI does it — answers calls, drafts estimates, chases invoices. The honest breakdown for a 1-3-truck shop.",
    category: 'Comparisons',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'jobber alternative',
    relatedSlugs: ['housecall-pro-csr-ai-booking-gap', 'ai-answering-service-cost-2026', 'what-happens-after-the-call'],
    body: [
      {
        kind: 'paragraph',
        text:
          "Jobber is scheduling, invoicing, and CRM software you operate yourself — and it's good at it. Its new AI Receptionist can answer calls and texts, too. Rivet is a voice-AI back office: it answers the phone, drafts the estimate off your own price book, sends the invoice, and chases the payment, without you opening a laptop. If you want better paperwork tools, Jobber fits. If you want the paperwork done, Rivet fits. Here's the honest breakdown, including where Jobber genuinely leads.",
      },
      { kind: 'heading', text: 'What Jobber does well' },
      {
        kind: 'paragraph',
        text:
          "Jobber's core product — scheduling, quoting, invoicing, client CRM — is mature and widely used across home-service trades, not just HVAC and plumbing. Pricing starts at [$29/mo billed annually ($39/mo monthly) for a single user](https://buyersprint.com/2026/04/17/jobber-pricing-2026/), climbing through Connect, Grow, and Plus tiers that add users and features, up to a Plus plan reported around $449–599/mo for teams of about 15. There's a 14-day free trial with no long-term contract, which is consistently reported across sources including [Jobber's own pricing page](https://www.getjobber.com/pricing/).",
      },
      { kind: 'heading', text: "Jobber's AI Receptionist: what it actually does" },
      {
        kind: 'paragraph',
        text:
          "Per [Jobber's AI Receptionist page](https://www.getjobber.com/features/ai-receptionist/) and its [help-center article](https://help.getjobber.com/hc/en-us/articles/25315927533847-Receptionist-powered-by-Jobber-AI), the Receptionist answers inbound calls and texts 24/7 in the shop's own voice, can offer to book a visit or capture request details, texts back callers who hang up, recognizes returning callers already in Jobber's CRM, and can transfer a live call or text the owner on trigger phrases you set. It logs everything to a dashboard in real time and handles multiple calls at once.",
      },
      {
        kind: 'paragraph',
        text:
          "It's included unlimited on the Plus plan, or available as an add-on on other plans at [$29/mo for 30 conversations, then $0.79 per additional conversation](https://www.getjobber.com/features/ai-receptionist/). One third-party analysis (not Jobber's own claim, so treat it as informed inference) notes the Receptionist covers calls and texts only — no WhatsApp, Instagram, Facebook Messenger, email, or web chat — and works only inside the Jobber ecosystem. See [that gap analysis here](https://reliablereceptionist.com/jobber-ai-receptionist-hvac-integration-gap/). Voice-driven quotes and invoices live in a separate in-app tool called \"[AI Voice and Chat (Beta)](https://help.getjobber.com/hc/en-us/articles/25315900454423-Jobber-AI-Voice-and-Chat-Beta)\", available to admin users on the mobile app — not something the phone Receptionist itself does for an inbound caller.",
      },
      { kind: 'heading', text: 'Where Rivet is different' },
      {
        kind: 'paragraph',
        text:
          "Rivet's AI answers the phone 24/7 in the shop's own voice, classifies what the caller needs, checks real availability — drive time and existing job conflicts, not just an open calendar slot — and proposes the booking. The owner approves with one tap by text; nothing books itself without a human saying yes. If a call sounds like a medical emergency, an elderly caller in distress, or severe weather, the AI stops booking and patches straight to the owner's phone instead of guessing. A dropped call gets an automatic text-back within about 60 seconds.",
      },
      {
        kind: 'paragraph',
        text:
          "After the call, Rivet keeps going: it drafts an estimate priced against the shop's own catalog (anything not in the catalog gets flagged for the owner to check, never guessed and sent), offers good/better/best tiers, and collects an e-signature and Stripe deposit on acceptance. When the job's done, the invoice drafts itself, goes out with a Stripe payment link, and follows a dunning cadence on anything unpaid. The owner gets an end-of-day text digest of what happened and what the AI wasn't sure about.",
      },
      {
        kind: 'table',
        headers: ['Capability', 'Jobber (Core + AI Receptionist)', 'Rivet'],
        rows: [
          ['Answers calls 24/7 in your voice', 'Yes', 'Yes'],
          ['Checks drive time + real conflicts before proposing a time', 'Not documented', 'Yes'],
          ['Drafts a catalog-priced estimate from the call', 'No — separate in-app tool, admin only', 'Yes, uncatalogued items flagged for review'],
          ['Sends the invoice and runs a payment-chasing cadence', 'Core invoicing yes; AI-driven, no', 'Yes'],
          ['Emergency / vulnerable-caller escalation to the owner', 'Not documented', 'Yes'],
          ['Pricing model', '$29/mo add-on for 30 conversations, then $0.79 each; unlimited on Plus (~$449–599/mo)', 'Flat $299–$799/mo, no per-conversation overage'],
        ],
      },
      { kind: 'heading', text: 'Where Jobber still leads' },
      {
        kind: 'paragraph',
        text:
          "Jobber covers far more trades than we do — lawn care, cleaning, general contracting, and more — with team plans up to roughly 15 users and a decade-plus track record. Its in-app \"AI Voice and Chat\" lets an admin build a quote or check the schedule hands-free from the field, which is a real, useful feature we don't claim to match. If you need broad multi-trade coverage or a bigger team tier than we're built for, Jobber's breadth is the stronger fit today.",
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "Rivet is built for 1–3-truck owner-operator HVAC and plumbing shops — the ones where the owner is also the dispatcher, the estimator, and the person chasing invoices between jobs. If you're running 10+ trucks with dedicated office staff, or you need Jobber's broader trade coverage, Jobber fits better. If you're past about 20 technicians with real dispatch complexity, look at [ServiceTitan](/resources/servicetitan-overkill-small-shop) instead — that's a different tier of software and budget entirely.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Can I use Jobber and Rivet together?',
            answer:
              "Not today — there's no shipped integration between them. Rivet runs as its own back office rather than as an add-on to Jobber.",
          },
          {
            question: "Does Jobber's AI Receptionist draft estimates?",
            answer:
              "Not the phone Receptionist itself. Per Jobber's own help docs, voice-driven quotes and invoices live in a separate in-app \"AI Voice and Chat (Beta)\" tool for admin users, not in the call-answering feature.",
          },
          {
            question: 'Is Rivet cheaper than Jobber?',
            answer:
              "It depends what you're comparing. Jobber's core paperwork software starts at $29/mo, but its AI Receptionist is metered per conversation past the included cap. Rivet's flat $299–$799/mo includes call-answering plus estimating, invoicing, and collections — compare what's included, not just the sticker price.",
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'See where your shop fits',
        text: 'Check the plans, or start a 14-day trial and let the AI answer your next call.',
        href: '/pricing',
        label: 'See pricing',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 2. Housecall-Pro cluster
  // ---------------------------------------------------------------------
  {
    slug: 'housecall-pro-csr-ai-booking-gap',
    title: "Housecall Pro's CSR AI Can't Book Jobs Yet",
    description:
      "Housecall Pro's CSR AI answers and qualifies calls, but its own help docs list job booking as coming soon. Here's what that gap means for a small shop.",
    category: 'Comparisons',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'housecall pro alternative',
    relatedSlugs: ['jobber-vs-rivet-who-does-the-paperwork', 'ai-answering-service-cost-2026', 'what-happens-after-the-call'],
    body: [
      {
        kind: 'paragraph',
        text:
          "As of Housecall Pro's own help center (accessed 2026-07-10), CSR AI answers calls and chats 24/7, asks clarifying questions, and tags the reason for the call — but autonomous job booking is explicitly listed as \"coming soon.\" That means a call still needs a human, or a separate tool, to turn into a booked, priced job. Rivet's AI proposes and books the visit itself, with the owner approving by one tap. Housecall Pro ships features quickly, so check its current docs before treating this gap as permanent — it's accurate as of this writing, not a forever-claim.",
      },
      { kind: 'heading', text: 'What Housecall Pro does well' },
      {
        kind: 'paragraph',
        text:
          "Housecall Pro is a mature field-service platform — scheduling, invoicing, payments, and trade-specific pages like its [plumbing estimating page](https://www.housecallpro.com/industries/plumbing-software/estimating/). Reported pricing runs Basic around [$59–79/mo, Essentials $149–189/mo (up to 5 users), and MAX $299–329/mo](https://costbench.com/software/field-service-management/housecall-pro/), with one source citing lower figures that conflict with those bands — treat $59–79/$149–189/$299–329 as the reconcilable range and verify current numbers directly. There's a 14-day free trial with full MAX-plan feature access and no credit card required, per [Housecall Pro's pricing page](https://www.housecallpro.com/pricing/).",
      },
      { kind: 'heading', text: "CSR AI: what's shipped, what's not" },
      {
        kind: 'paragraph',
        text:
          "Per the [CSR AI overview](https://help.housecallpro.com/en/articles/9740104-csr-ai-overview) and [feature page](https://www.housecallpro.com/features/ai-team/csr-ai/), CSR AI answers calls and chats around the clock, gives empathetic, clarifying responses, and lets you customize its voice and behavior. A [February 2026 update](https://www.housecallpro.com/resources/february-2026-product-updates/) added call-reason tagging — New Job Inquiry, Emergency Repair, Follow-Up, Sales Call — for revenue-source tracking.",
      },
      {
        kind: 'paragraph',
        text:
          "The gap: job booking is listed as \"coming soon\" in Housecall Pro's own help center as of this writing. In the meantime, third-party AI voice add-ons — Kickcall, AgentZap, Smith.ai, Rosie, and Goodcall among them — bolt onto Housecall Pro to handle booking today. That means the booking loop for a Housecall Pro shop currently runs through an external vendor stacked on top of the core software, not through Housecall Pro's own AI.",
      },
      { kind: 'heading', text: 'What Rivet does differently' },
      {
        kind: 'paragraph',
        text:
          "Rivet's AI checks real availability — drive time and actual job conflicts, not just an open slot — and proposes the booking itself; the owner approves with one tap by text, and the loop closes without a dispatcher or a bolt-on vendor. It also detects emergencies and vulnerable-caller situations and routes those straight to the owner's phone instead of trying to book them. A dropped call gets an automatic text-back within about 60 seconds. After the booking, the same AI drafts a catalog-priced estimate, sends the invoice when the job's done, and runs a payment-chasing cadence — one system, not a stack of vendors.",
      },
      {
        kind: 'table',
        headers: ['Capability', 'Housecall Pro CSR AI', 'Rivet'],
        rows: [
          ['Answers & qualifies calls 24/7', 'Yes', 'Yes'],
          ['Books the job autonomously', 'Coming soon (per HCP help center, accessed 2026-07-10)', 'Yes'],
          ['Drafts a priced estimate from the call', 'No', 'Yes, catalog-priced, uncatalogued items flagged'],
          ['Invoicing + payment collection', 'Core invoicing yes; AI-driven cadence, no', 'Yes, auto-draft + Stripe payment link + dunning'],
          ['Pricing (software)', '$59–79 / $149–189 / $299–329 per mo (verify current)', 'Flat $299–$799/mo'],
        ],
      },
      { kind: 'heading', text: 'What the February update actually changes' },
      {
        kind: 'paragraph',
        text:
          "The call-reason tagging Housecall Pro added in [February 2026](https://www.housecallpro.com/resources/february-2026-product-updates/) is a reporting feature, not a booking feature — it labels a call as New Job Inquiry, Emergency Repair, Follow-Up, or Sales Call so the shop can see where revenue is coming from later. That's useful for a shop owner reviewing the week, but it doesn't change what happens the moment the call ends: a New Job Inquiry still needs a person to check the schedule, quote the work, and confirm it, the same as before the tag existed.",
      },
      { kind: 'heading', text: 'Where Housecall Pro still leads' },
      {
        kind: 'paragraph',
        text:
          "Housecall Pro has a broader, longer-proven FSM feature set, a generous 14-day full-feature trial, and its own trade-specific landing content, including dedicated plumbing and HVAC estimating pages. If your priority is a proven scheduling-and-invoicing platform and you're comfortable handling booking yourself — or stacking on a separate AI vendor for that — Housecall Pro is a reasonable, well-supported choice, and one with a much longer track record in the field than any newer voice-AI entrant, us included.",
      },
      {
        kind: 'paragraph',
        text:
          "It's also worth being honest about what Rivet doesn't try to be here: we're not a general-purpose FSM platform with the breadth of modules, integrations, and reporting that Housecall Pro has built up over years. If you need that breadth — deep payroll integrations, a large marketplace of add-ons, support for trades well outside HVAC and plumbing — that's a real reason to stay on Housecall Pro rather than switch.",
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "Rivet is built for 1–3-truck HVAC and plumbing owner-operators who want the call-to-cash loop closed without hiring a dispatcher or bolting a separate AI vendor onto their FSM tool. If you run a larger, multi-trade operation, or you need Housecall Pro's broader plan tiers, that platform likely fits better. At real scale — 20+ techs with dedicated office staff — look at [ServiceTitan](/resources/servicetitan-overkill-small-shop) instead.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Has Housecall Pro shipped autonomous booking since this was written?',
            answer:
              "Check its current help docs — this reflects Housecall Pro's own materials as of 2026-07-10, and AI feature roadmaps move fast.",
          },
          {
            question: 'Do I need a separate AI vendor if I use Housecall Pro?',
            answer:
              "Today, yes, if you want autonomous booking — CSR AI doesn't do it yet, so shops commonly add a separate vendor like Kickcall, AgentZap, Smith.ai, Rosie, or Goodcall for that piece.",
          },
          {
            question: 'Does Rivet integrate with Housecall Pro?',
            answer:
              'No — Rivet runs as your back office rather than as a booking add-on to another FSM platform.',
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'See the whole loop in one place',
        text: 'Compare plans or start a 14-day trial — card required, cancel anytime before day 15.',
        href: '/pricing',
        label: 'See pricing',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 3. AI-receptionist-for-contractors cluster
  // ---------------------------------------------------------------------
  {
    slug: 'ai-receptionist-for-contractors-guide',
    title: 'AI Receptionist for Contractors: What to Look For',
    description:
      'Most AI receptionists for contractors just answer the phone and hand you a lead. Five questions to ask, and where a plain answering service is enough.',
    category: 'Guides',
    publishedAt: '2026-07-10',
    readingMinutes: 6,
    author: 'Rivet team',
    targetQuery: 'ai receptionist for contractors',
    relatedSlugs: ['what-happens-after-the-call', 'missed-calls-after-hours-cost-your-shop', 'jobber-vs-rivet-who-does-the-paperwork'],
    body: [
      {
        kind: 'paragraph',
        text:
          "An AI receptionist for contractors answers your phone and captures the caller's information; a smaller number can also propose a booking. Most stop there — they hand you a lead or a callback slip, and the paperwork is still on you. The best fit for a 1–3-truck HVAC or plumbing shop answers the phone and keeps going: checks your real schedule, books the visit, and — with Rivet — drafts the estimate and invoice too. Here's how to evaluate any AI receptionist, including ours.",
      },
      { kind: 'heading', text: 'A crowded field of point solutions' },
      {
        kind: 'paragraph',
        text:
          "Search \"AI receptionist for HVAC\" or \"AI answering service for plumbers\" and you'll find a long list of single-purpose vendors: [evs7](https://www.evs7.com/industries/ai-answering-service-for-hvac), [Ring Ready](https://www.ring-ready.com/industries/hvac) (advertising a $39/mo flat plan), [NextPhone](https://www.getnextphone.com/blog/best-virtual-receptionist-for-hvac) (advertising $199/mo flat), [Marlie](https://www.marlie.ai/industries/plumbers-answering-service) (advertising $49/mo plus $0.35/minute), and [AgentZap](https://agentzap.ai/industries/plumbing) (advertising $109/mo flat), among others. They all answer calls. Some book into your existing scheduling tool. None of them draft an estimate or send an invoice — the paperwork still lands back on you once the call ends.",
      },
      { kind: 'heading', text: 'Five questions to ask any AI receptionist vendor' },
      {
        kind: 'list',
        items: [
          'Does it check your real calendar — drive time and existing job conflicts — or just take a message and let you sort out the schedule later?',
          'Does it recognize an emergency or a vulnerable caller and route to a human, or does it try to book everything the same way?',
          "Does it answer in your shop's own voice, or does it sound like a generic call center?",
          'After it books the call, do you still have to build the estimate and send the invoice yourself?',
          'Is pricing flat, or per-conversation / per-minute — and what happens to your bill in your busiest month?',
        ],
      },
      { kind: 'heading', text: 'Where Rivet answers these' },
      {
        kind: 'paragraph',
        text:
          "Rivet checks real availability — drive time plus actual job conflicts — before proposing a time, and the owner approves the booking with one tap by text. Medical, elderly, or severe-weather situations stop the booking flow and route straight to the owner's phone instead of getting a generic \"someone will call you back.\" It answers in the shop's own voice. After the call, it drafts a catalog-priced estimate (anything outside the catalog gets flagged for the owner, never guessed), sends the invoice on job completion, and runs a payment-chasing cadence. Pricing is flat — $299, $499, or $799 a month — with no per-conversation or per-minute overage.",
      },
      { kind: 'heading', text: 'Where a plain answering service is enough' },
      {
        kind: 'paragraph',
        text:
          "If all you need right now is a message taken while you're on a roof — and someone else is already handling the estimate and invoice — a cheap, flat-rate point solution in the $39–199/mo range might cover you for now. The gap shows up once call volume grows, or once you notice the paperwork is eating your evenings even though the phone's getting answered.",
      },
      { kind: 'heading', text: 'How to actually test one before you buy' },
      {
        kind: 'list',
        items: [
          "Call your own number after hours, pretending to be a customer with a real, specific problem — see if it sounds like your shop or like a generic script.",
          "Try a borderline emergency (a strange smell, a leak that could be serious) and see whether it books a routine appointment or flags it for a human.",
          "Ask it to move a time slot around and see whether it seems to know your actual schedule, or is just offering whatever's open on a calendar.",
          "Check what happens to the lead after the call ends — do you get a message to act on, or does something actually move forward (a quote, a confirmation) on its own?",
          "Read the pricing page for the word \"conversation\" or \"minute\" — that's where a cheap-looking plan can turn expensive in a busy month.",
        ],
      },
      {
        kind: 'table',
        headers: ['What it does', 'Typical point-solution AI receptionist', 'Rivet'],
        rows: [
          ['Answers calls 24/7', 'Yes', 'Yes'],
          ['Checks real availability before booking', 'Rarely documented', 'Yes (drive time + job conflicts)'],
          ['Drafts a priced estimate', 'No', 'Yes, catalog-priced'],
          ['Sends the invoice and chases payment', 'No', 'Yes'],
          ['Typical pricing', '$39–$299/mo flat, or per-minute / per-conversation', 'Flat $299–$799/mo'],
        ],
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "Rivet is built for 1–3-truck HVAC and plumbing owner-operators without a dispatcher. If you run a larger multi-crew operation with dedicated office staff and need deep dispatch and pricebook tooling at scale, [ServiceTitan](/resources/servicetitan-overkill-small-shop) is built for that — Rivet isn't trying to be that.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Is an AI receptionist the same as an answering service?',
            answer:
              'A traditional answering service routes calls to a live human who relays a message. An AI receptionist automates that, with varying degrees of booking capability depending on the vendor.',
          },
          {
            question: 'Will an AI receptionist sound robotic to my customers?',
            answer:
              "Quality varies a lot by vendor. Rivet is built to answer in the shop's own voice — and like any AI, it can be unsure sometimes. When it is, it says so instead of guessing.",
          },
          {
            question: 'What if the AI gets an estimate price wrong?',
            answer:
              "Every line item is grounded in the shop's own price catalog. Anything not in the catalog gets flagged for the owner to review — it's never auto-approved or sent blind.",
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'Try it on your own phone number',
        text: 'Start a 14-day trial and hear how it answers your next call.',
        href: '/signup',
        label: 'Start free trial',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 4. Missed-calls / after-hours cluster
  // ---------------------------------------------------------------------
  {
    slug: 'missed-calls-after-hours-cost-your-shop',
    title: 'Missed Calls and After-Hours Calls: The Real Cost',
    description:
      "A missed call costs roughly $1,200 in a home-service business, per Invoca's data. Why callback texts alone don't fix it, and what actually closes the loop.",
    category: 'Guides',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'how to stop missing calls plumbing business',
    relatedSlugs: ['ai-receptionist-for-contractors-guide', 'what-happens-after-the-call', 'ai-answering-service-cost-2026'],
    body: [
      {
        kind: 'paragraph',
        text:
          "About 27% of calls to home-service businesses go unanswered, and each missed call costs roughly [$1,200 in lost revenue on average, per Invoca](https://www.invoca.com/blog/how-much-missed-sales-calls-cost-home-services-businesses) — a call-tracking vendor reporting on its own platform data, not an independent academic study, so treat it as directionally useful rather than gospel. A meaningful share of that volume happens after hours, when emergencies don't wait for business hours and the first shop to answer usually gets the job. Voicemail and callback texts capture that a call happened. They don't get it booked.",
      },
      { kind: 'heading', text: 'Why a missed call costs more than it looks like it should' },
      {
        kind: 'paragraph',
        text:
          "Invoca's figures come from aggregating roughly 4.2 million inbound calls a year across HVAC, plumbing, roofing, and electrical businesses — a large, vendor-reported dataset, worth citing with that context attached rather than as neutral third-party research. Separately, it's widely reported across industry content that most callers who reach voicemail don't leave a message and simply call the next name on the list — that specific figure isn't tied to one traceable, independently audited study, so take it as a directional pattern rather than a hard number.",
      },
      { kind: 'heading', text: 'After-hours calls are a different animal' },
      {
        kind: 'paragraph',
        text:
          "A burst pipe or a dead furnace at 11pm is a different kind of call than a routine tune-up request — it's urgent, and the caller is often already dialing the next number if the first one doesn't pick up. Some after-hours-answering vendors advertise that a large share of contractor calls land outside normal business hours (see, for example, [Swiftly's write-up on after-hours coverage](https://www.withswiftly.com/blog/why-after-hours-customer-service-is-make-or-break-for-contractors)) — exact percentages vary by source and aren't independently audited, so we won't adopt a specific number as fact here, but the underlying pattern (nights and weekends carry real emergency volume) matches what most owner-operators already know from experience.",
      },
      { kind: 'heading', text: 'What actually closes the loop' },
      {
        kind: 'paragraph',
        text:
          "Rivet answers 24/7 in the shop's own voice, checks real availability — drive time and job conflicts — and proposes the booking, with the owner approving by one tap. A dropped call gets an automatic text-back within about 60 seconds, so a bad connection doesn't turn into a lost job. And when a call sounds like a real emergency — medical, an elderly caller in distress, severe weather — the AI stops trying to book it and patches straight to the owner's phone. That's a deliberately safety-conscious behavior most lead-capture bots don't document at all.",
      },
      {
        kind: 'table',
        headers: ['Approach', 'Answers immediately', 'Books the job', 'Detects emergencies', 'Typical cost'],
        rows: [
          ['Voicemail + manual callback', 'No', 'No', 'No', "Free — but you're likely racing a competitor"],
          ['Traditional live answering service', 'Yes', 'No (takes a message)', 'Rarely', '$200–$2,000/mo'],
          ['Rivet', 'Yes', 'Yes', 'Yes — escalates to you', '$299–$799/mo flat'],
        ],
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "This is built for a 1–3-truck HVAC or plumbing shop where the owner is also the one who'd otherwise be answering the phone at 11pm. If you have a dedicated after-hours dispatcher already, or you run a larger multi-crew operation, a platform like [ServiceTitan](/resources/servicetitan-overkill-small-shop) with a full call center integration may be the better fit for that scale.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Do most missed calls really turn into lost jobs?',
            answer:
              "It varies by shop, but the pattern of \"whoever answers first tends to win the job\" is widely reported, and Invoca's data on missed-call cost (about $1,200 per missed call, on average) suggests the stakes are real.",
          },
          {
            question: "What if it's a real emergency at 2am?",
            answer:
              "Rivet stops booking and patches the call straight to the owner's phone for medical, elderly, or severe-weather situations — it doesn't try to handle those on its own.",
          },
          {
            question: "Isn't a callback text good enough?",
            answer:
              'A callback text confirms you got the message. It doesn\'t check your schedule or book anything — the caller is still deciding whether to try the next shop while they wait.',
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'Stop losing after-hours calls',
        text: 'See how the AI handles a call at 11pm, on your own number, in a 14-day trial.',
        href: '/signup',
        label: 'Start free trial',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 5. Best-software-small-shop cluster
  // ---------------------------------------------------------------------
  {
    slug: 'best-software-small-hvac-plumbing-shop',
    title: 'Best Software for a 1-3 Truck HVAC or Plumbing Shop',
    description:
      "Scheduling apps for small shops all look similar on a features page. What actually matters at 1-3 trucks, and why the software alone isn't the whole fix.",
    category: 'Guides',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'best software for small plumbing business',
    relatedSlugs: ['servicetitan-overkill-small-shop', 'jobber-vs-rivet-who-does-the-paperwork', 'ai-receptionist-for-contractors-guide'],
    body: [
      {
        kind: 'paragraph',
        text:
          "If you run 1–3 trucks, you don't need enterprise field-service software — you need something that schedules jobs and sends invoices without requiring a full-time admin to run it. Most \"best software for small plumbing or HVAC business\" lists compare scheduling grids and price tiers. Fewer of them ask who actually answers the phone and drafts the estimate while you're the one under the sink.",
      },
      { kind: 'heading', text: 'What the small-shop software landscape looks like' },
      {
        kind: 'paragraph',
        text:
          "[QuoteIQ](https://myquoteiq.com/best-jobber-alternative-in-2026/) positions itself as the budget, owner-operator-friendly option with a flat-rate ladder reported from about $29.99 to $699/mo, and an \"[AI Estimator](https://myquoteiq.com/top-10-plumbing-field-service-software-in-2026/)\" that turns job descriptions into a priced quote in seconds. [CrewRoute](https://crewroute.app/resources/best/best-hvac-software-small-business/) targets the same 1–3-truck segment explicitly, with flat pricing reported around $79/mo solo and $149/mo for a 2–5-truck crew. Both are genuinely built for small shops — and both are tools you still have to sit down and operate.",
      },
      { kind: 'heading', text: 'What actually matters at this size' },
      {
        kind: 'list',
        items: [
          'Fast setup — no multi-month onboarding process for a 1–3-truck shop',
          'Flat, predictable pricing — no per-user creep as you add a second truck',
          "Quotes priced from the shop's own price book, not a generic template",
          "Something answering the phone when you're on a job, not just a scheduling grid",
          "Invoicing that goes out when the job's done, not whenever you get to a laptop",
        ],
      },
      { kind: 'heading', text: 'The gap most "best software" lists miss' },
      {
        kind: 'paragraph',
        text:
          "Even the best-reviewed FSM tool for a small shop still requires the owner to answer the phone, build the quote, and hit send on the invoice — the app just makes each of those steps a little easier. Rivet's difference is that the AI operates the back office starting from a phone call: it answers, checks real availability, books the visit, drafts an estimate priced against the shop's own catalog (uncatalogued items flagged for the owner, never guessed), and sends the invoice automatically when the job's done, with a payment-chasing cadence behind it. It's an operator, not a nicer app to operate yourself.",
      },
      {
        kind: 'table',
        headers: ['What you still do yourself', 'Typical small-shop FSM tool', 'Rivet'],
        rows: [
          ['Answer the phone', 'You or your team', 'AI, 24/7'],
          ['Build the estimate', "You, using the app's templates", 'AI drafts it from the call, priced off your catalog'],
          ['Send the invoice', 'You, when you get to a laptop', 'Auto-drafted on job completion'],
          ['Chase late payments', 'You', 'Automated cadence with capped late fees'],
          ['Typical pricing', '$20–$700/mo depending on tier', '$299–$799/mo flat'],
        ],
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "This is built for 1–3-truck HVAC and plumbing owner-operators specifically — not lawn care, cleaning, or general multi-trade work. If you need broader trade coverage, or you've already grown past 10+ techs with dedicated office staff, a full FSM platform like Jobber or Housecall Pro, or at real scale [ServiceTitan](/resources/servicetitan-overkill-small-shop), will fit better than an AI-operator model built for a solo or small crew.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Is Rivet a field service management (FSM) tool?',
            answer:
              "Not exactly. It's built to run the phone-to-cash workflow itself, rather than hand you a nicer scheduling grid to run it in yourself.",
          },
          {
            question: 'What if my shop does more than HVAC and plumbing?',
            answer:
              "Rivet's catalog resolution and voice flows are built and tuned for HVAC and plumbing specifically. Other trades aren't a current fit.",
          },
          {
            question: "I'm at 8 trucks with an office manager — is this still for me?",
            answer:
              "Rivet is built for 1–3-truck owner-operators without dedicated office staff. At your size, a broader FSM platform, or ServiceTitan if you're scaling further, likely fits better.",
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'See what fits your shop size',
        text: 'Compare plans built for 1-3 trucks, or start a 14-day trial.',
        href: '/pricing',
        label: 'See pricing',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 6. AI-answering-service-cost cluster
  // ---------------------------------------------------------------------
  {
    slug: 'ai-answering-service-cost-2026',
    title: 'The Real Cost of an AI Answering Service in 2026',
    description:
      'AI answering services are priced per-minute, per-conversation, or flat. What the bands actually look like, and why per-call pricing hides costs.',
    category: 'Pricing',
    publishedAt: '2026-07-10',
    readingMinutes: 6,
    author: 'Rivet team',
    targetQuery: 'ai answering service cost',
    relatedSlugs: ['ai-receptionist-for-contractors-guide', 'jobber-vs-rivet-who-does-the-paperwork', 'housecall-pro-csr-ai-booking-gap'],
    body: [
      {
        kind: 'paragraph',
        text:
          "Budget AI answering tools run about [$25–65/month for a capped number of calls with no emergency routing; flat-rate AI tiers run $149–299/month unlimited; human-hybrid services run $255–1,275+/month](https://www.getnextphone.com/blog/ai-receptionist-pricing-guide); traditional live answering services run $200–2,000/month. The catch in a lot of these bands is what's not included — emergency handling, actual booking, or a call cap that quietly turns into an overage fee the moment you get busy.",
      },
      { kind: 'heading', text: 'The pricing bands, in plain numbers' },
      {
        kind: 'table',
        headers: ['Tier', 'Typical price', 'What you usually get'],
        rows: [
          ['Budget AI answering', '$25–$65/mo', '30–50 call cap, no emergency routing'],
          ['Flat-rate AI, unlimited', '$149–$299/mo', 'Unlimited calls, basic booking or message-taking'],
          ['Human-hybrid (AI + live backup)', '$255–$1,275+/mo', 'Blended AI/human coverage'],
          ['Traditional live answering service', '$200–$2,000/mo', 'A live person relays messages; rarely books'],
        ],
        caption: "Bands per getnextphone.com's AI receptionist pricing guide, accessed 2026-07-10.",
      },
      { kind: 'heading', text: 'Where per-conversation pricing adds up' },
      {
        kind: 'paragraph',
        text:
          "Take Jobber's own AI Receptionist add-on as a worked example: [$29/mo for 30 conversations, then $0.79 per additional conversation](https://www.getjobber.com/features/ai-receptionist/). A shop handling 80 conversations in a busy month pays $29 plus 50 × $0.79 — about $68.50 for the phone-answering add-on alone that month, before the core paperwork subscription. Some point-solution vendors price per-minute instead — [Marlie](https://www.marlie.ai/industries/plumbers-answering-service) reports $49/mo plus $0.35/minute — which can look cheap on the homepage and get expensive in exactly the month you're busiest and need it most.",
      },
      { kind: 'heading', text: "What Rivet charges, and what's included" },
      {
        kind: 'paragraph',
        text:
          "Rivet is flat: $299/mo (Solo), $499/mo (Shop), or $799/mo (Pro) — no per-conversation or per-minute overage, regardless of call volume. There's a 14-day free trial, card required, cancel anytime before day 15. Beyond call-answering, that price covers catalog-priced estimate drafting, automatic invoicing with a dunning cadence, a unified inbox for calls/texts/email, an end-of-day digest, and one-way QuickBooks sync for paid invoices. Comparing sticker price alone against a $25/mo capped plan undersells what's actually bundled in.",
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "This pricing is built around a 1–3-truck HVAC or plumbing shop's call volume and paperwork load. If you're comparing purely on a per-call basis and you have very low volume, a capped $25–65/mo plan may look cheaper on paper — you'd just be buying the phone line, not the estimate, invoice, and collections that come after it.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Is $299/mo expensive for an answering service?',
            answer:
              "Compared to a $25/mo capped plan, yes, on paper. Compared to a traditional live answering service ($200–2,000/mo) or a per-conversation add-on that spikes in a busy month, Rivet's flat price covers more of the workflow than just the phone line.",
          },
          {
            question: 'Does Rivet charge extra for busy months?',
            answer:
              'No — pricing is flat regardless of call volume, with no per-conversation or per-minute overage.',
          },
          {
            question: 'Is there a free trial?',
            answer: '14 days, card required, cancel anytime before day 15.',
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'Compare the flat plans',
        text: "See exactly what's included at each tier.",
        href: '/pricing',
        label: 'See pricing',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 7. ServiceTitan-overkill cluster
  // ---------------------------------------------------------------------
  {
    slug: 'servicetitan-overkill-small-shop',
    title: 'ServiceTitan Is Overkill for a 1-3-Truck Shop',
    description:
      "ServiceTitan is built for 20+ tech shops with office staff, not a 1-3-truck operation. What it costs per third-party estimates, and what to use instead.",
    category: 'Comparisons',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'best hvac software for small business',
    relatedSlugs: ['best-software-small-hvac-plumbing-shop', 'jobber-vs-rivet-who-does-the-paperwork', 'ai-answering-service-cost-2026'],
    body: [
      {
        kind: 'paragraph',
        text:
          "ServiceTitan doesn't publish pricing, but third-party estimates put it around $245–500+ per technician per month, plus $5,000–$50,000+ in setup fees and a 12+ month contract. It's consistently described, across independent buyer guides, as built for operations with $1M+ in revenue or 20+ technicians and dedicated office staff to run it. If you're running 1–3 trucks, that's a different tier of software than you need — and a lot of the buyer guides ranking for this exact search already say so.",
      },
      { kind: 'heading', text: 'What ServiceTitan actually costs — with a hedge' },
      {
        kind: 'paragraph',
        text:
          "ServiceTitan's own [pricing page](https://www.servicetitan.com/pricing) publishes no numbers — it's a sales-quote model. The figures available come from reseller and consultant blogs: [$245–500+/tech/month](https://projul.com/blog/servicetitan-pricing-analysis-2026/), corroborated in similar ranges by [fieldcamp.ai](https://fieldcamp.ai/reviews/servicetitan/) and [myquoteiq.com](https://myquoteiq.com/servicetitan-pricing-per-month/), plus setup fees in the $5,000–$50,000+ range and 3–6+ month (sometimes longer) onboarding, with 12+ month contracts and early-termination fees reported at $5,000–$20,000+. Mark all of this as third-party estimate, not a confirmed price — there's no free trial, and it's an enterprise sales-demo process.",
      },
      { kind: 'heading', text: "What it's actually built for" },
      {
        kind: 'paragraph',
        text:
          "ServiceTitan's AI initiative, [Titan Intelligence](https://www.servicetitan.com/features/titan-intelligence), includes Dispatch Pro (auto-matching jobs to technicians by skill, proximity, history, and expected revenue), a TI Chat Assistant trained on the business's own call recordings that can book jobs and answer questions, and Atlas, a general AI copilot across the product. That's genuinely capable dispatch-and-scale tooling. One caveat worth noting: a [Capterra reviewer-composition note](https://www.capterra.com/p/150053/ServiceTitan/) cites 92% of reviewers on that platform self-identifying as small business — that's reviewer-mix data on one review site, not a targeting claim, and it sits in tension with the \"$1M+/20+ techs\" framing from independent buyer guides. Read it as a caveat, not a contradiction of the core positioning.",
      },
      { kind: 'heading', text: 'What a 1-3 truck shop actually needs instead' },
      {
        kind: 'paragraph',
        text:
          "Multiple independent buyer guides already reach the same conclusion for this exact search: don't buy ServiceTitan at 1–3 trucks, you don't need the complexity. The real problem at that size usually isn't which scheduling grid to use — it's that there's no one to answer the phone or do the paperwork while the owner's on a job. That's the gap Rivet is built to close: the AI answers the phone 24/7, checks real availability, proposes the booking (owner approves by one tap), drafts a catalog-priced estimate, sends the invoice on completion, and runs a payment-chasing cadence — all for a flat monthly price, no setup fee, no annual contract.",
      },
      {
        kind: 'table',
        headers: ['', 'ServiceTitan', 'Rivet'],
        rows: [
          ['Built for', '20+ techs, $1M+ revenue, dedicated office staff (per third-party buyer guides)', '1–3-truck owner-operators'],
          ['Pricing', 'No public pricing; third-party estimates $245–500+/tech/mo (unverified)', 'Flat $299–$799/mo'],
          ['Setup', '$5,000–$50,000+; 3–6+ month onboarding (third-party estimates)', 'Design target: signup to first AI-handled call in under 48 hours'],
          ['Contract', '12+ month annual commitment reported as standard', 'No long-term contract; 14-day free trial'],
          ['Who answers the phone', 'Titan Intelligence chat assistant / your CSR team', "Rivet's AI, 24/7"],
        ],
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "If you're at real scale — 20+ technicians, a dedicated office and dispatch team, complex multi-crew routing — ServiceTitan's dispatch and pricebook tooling is built for exactly that, and Rivet isn't trying to compete there. Rivet is for the shop before that point: 1–3 trucks, no dispatcher, the owner still doing the phone and the paperwork personally.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Does ServiceTitan have a free trial?',
            answer:
              "No — per third-party and reseller sources, it's a sales-demo, quote-only model with no published pricing.",
          },
          {
            question: 'What if I outgrow Rivet?',
            answer:
              "Rivet is built for 1–3-truck shops. If you scale well past that with a dedicated office team, a platform built for that scale, like ServiceTitan, is a reasonable next step.",
          },
          {
            question: "Are ServiceTitan's AI features better than Rivet's?",
            answer:
              "Titan Intelligence includes dispatch-matching and a call-trained chat assistant aimed at larger, multi-crew operations. Rivet's AI is built specifically to run the whole call-to-cash loop for a 1–3-truck shop without a dispatcher. Different tools for different sizes.",
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'Built for the shop before ServiceTitan',
        text: 'See the flat plans for a 1-3 truck HVAC or plumbing shop.',
        href: '/pricing',
        label: 'See pricing',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // 8. What-happens-after-the-call cluster
  // ---------------------------------------------------------------------
  {
    slug: 'what-happens-after-the-call',
    title: 'What Happens After the Call? The AI Receptionist Gap',
    description:
      'Most AI receptionists end at booking a lead. What should happen next — the estimate, the invoice, the follow-up — and who actually does it today.',
    category: 'Guides',
    publishedAt: '2026-07-10',
    readingMinutes: 7,
    author: 'Rivet team',
    targetQuery: 'ai receptionist for hvac companies',
    relatedSlugs: ['ai-receptionist-for-contractors-guide', 'jobber-vs-rivet-who-does-the-paperwork', 'housecall-pro-csr-ai-booking-gap'],
    body: [
      {
        kind: 'paragraph',
        text:
          "Most AI receptionists answer the phone, capture the caller's information, and maybe offer a time slot. Then they stop. Someone still has to turn that call into a priced estimate, get it signed, invoice the job, and chase the payment. That's the gap. Rivet is built to treat the call as the start of that workflow, not the end of it.",
      },
      { kind: 'heading', text: 'The lead-capture ceiling, even among the big FSM players' },
      {
        kind: 'paragraph',
        text:
          "This ceiling shows up even in the AI features that Jobber and Housecall Pro — two of the biggest FSM platforms — have shipped themselves. Jobber's [AI Receptionist](https://www.getjobber.com/features/ai-receptionist/) can answer, capture details, and offer to book, but voice-driven quotes and invoices live in a separate in-app tool for admins, not in the call-answering feature a customer talks to. Housecall Pro's [CSR AI](https://help.housecallpro.com/en/articles/9740104-csr-ai-overview) answers and qualifies calls, but lists autonomous job booking itself as \"coming soon\" as of this writing. If two well-funded incumbents haven't fully closed this loop in their own core AI yet, it's a real gap, not a strawman.",
      },
      { kind: 'heading', text: 'What should happen after "you\'re booked"' },
      {
        kind: 'list',
        items: [
          "An estimate priced off the shop's actual price book, not a generic guess",
          'A way for the customer to approve and pay a deposit without a round of phone tag',
          "An invoice that goes out the moment the job's done, not whenever the owner gets to a laptop",
          'A follow-up nudge on an estimate nobody has signed yet',
          "A plain-English note if anything the AI wasn't sure about needs a human look",
        ],
      },
      { kind: 'heading', text: 'How Rivet closes the loop' },
      {
        kind: 'paragraph',
        text:
          "Estimates are voice-drafted from the call and priced against the tenant's own catalog — anything uncatalogued gets flagged for the owner rather than guessed — with good/better/best tiers, e-signature, and a Stripe deposit on acceptance. Unsold estimates get an automatic follow-up cadence. Invoicing auto-drafts on job completion with a Stripe payment link, runs a dunning cadence, and applies capped late fees automatically. An end-of-day text digest summarizes the day's activity, including what the AI wasn't sure about and what it learned. Every one of those AI actions is a typed proposal that needs the owner's approval — nothing auto-executes — with a full audit trail, undo, a second-pass review agent, and a hard rule that the AI never discounts a price on its own.",
      },
      { kind: 'heading', text: "What this doesn't mean (yet)" },
      {
        kind: 'paragraph',
        text:
          "To be straight about the edges: Rivet doesn't turn a photo into a quote automatically today — photo capture exists, but automatic image-to-estimate analysis isn't built, and we treat that as a roadmap item, not a shipped feature. Payments run through cards and Stripe payment links, not ACH. And there's no property-manager or B2B account routing yet — no sub-accounts, no priority flows for larger commercial accounts. If any of those are must-haves for your shop today, they're not here yet.",
      },
      {
        kind: 'table',
        headers: ['Stage', 'Typical AI receptionist', 'Rivet'],
        rows: [
          ['Answer & qualify the call', 'Yes', 'Yes'],
          ['Check real availability & book', 'Sometimes, varies by vendor', 'Yes'],
          ['Draft a priced estimate', 'No', 'Yes, catalog-priced'],
          ['Get it signed + collect a deposit', 'No', 'Yes, e-sign + Stripe deposit'],
          ['Invoice + chase payment', 'No', 'Yes, auto-draft + dunning'],
          ['Follow up on unsold estimates', 'No', 'Yes, automatic cadence'],
        ],
      },
      { kind: 'heading', text: "Where Rivet fits, and where it doesn't" },
      {
        kind: 'paragraph',
        text:
          "This is built for 1–3-truck HVAC and plumbing owner-operators who want the whole call-to-cash loop handled, not just the phone answered. If you're running a larger operation with dedicated office staff and complex multi-crew dispatch, [ServiceTitan](/resources/servicetitan-overkill-small-shop) is built for that scale — Rivet is built for the shop before that point.",
      },
      {
        kind: 'faq',
        items: [
          {
            question: 'Do I have to approve everything the AI does?',
            answer:
              'Yes. Every AI action is a typed proposal that needs your approval — nothing auto-executes, and every mutation is logged with an audit trail and an undo.',
          },
          {
            question: "What happens if the AI isn't sure about a price?",
            answer:
              "Uncatalogued items are flagged and capped below the auto-approve confidence threshold — they're never sent to a customer without the owner seeing them first.",
          },
          {
            question: 'Can it turn a photo into a quote?',
            answer:
              "Not yet. Photo capture exists, but automatic image-to-estimate analysis isn't built — today, estimates are voice-drafted from the call.",
          },
        ],
      },
      {
        kind: 'cta',
        heading: 'See the whole loop, not just the phone call',
        text: 'Start a 14-day trial and watch a call turn into a booked, priced, invoiced job.',
        href: '/signup',
        label: 'Start free trial',
      },
    ],
  },
];

export function getArticle(slug: string): Article | undefined {
  return ARTICLES.find((a) => a.slug === slug);
}

export function allArticleSlugs(): string[] {
  return ARTICLES.map((a) => a.slug);
}

/**
 * Curated related articles for cross-linking. Falls back to the most recent
 * other articles if a relatedSlugs list isn't set or points at nothing found.
 */
export function getRelatedArticles(article: Article, limit = 3): Article[] {
  if (article.relatedSlugs && article.relatedSlugs.length > 0) {
    const picked = article.relatedSlugs
      .map((slug) => getArticle(slug))
      .filter((a): a is Article => Boolean(a) && a!.slug !== article.slug);
    if (picked.length > 0) return picked.slice(0, limit);
  }
  return ARTICLES.filter((a) => a.slug !== article.slug).slice(0, limit);
}

/** Distinct categories, in first-seen order, for grouping on the index page. */
export function articleCategories(): string[] {
  const seen = new Set<string>();
  const cats: string[] = [];
  for (const a of ARTICLES) {
    if (!seen.has(a.category)) {
      seen.add(a.category);
      cats.push(a.category);
    }
  }
  return cats;
}
