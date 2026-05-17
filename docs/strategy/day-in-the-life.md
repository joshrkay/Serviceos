# Day in the Life — The Serviceos Customer

**Purpose**: This document is the emotional and operational spine of Serviceos.
It is the source of truth for the pitch deck, the homepage, the PRD, and the
customer interview script. Every feature we ship must move a moment from the
left column to the right column. Every feature that does not, doesn't ship.

If we drift, we come back here.

---

## The pitch in one sentence

> **You learned the trade. We'll run the business.**
> AI answers your phone, books your jobs, sends your estimates, and chases your
> invoices. You approve what matters in 30 seconds a day.
>
> Built for the shop with 2 trucks and no office.

---

## Persona 1 — Mike (HVAC, Phoenix, peak season)

**Mike Rivera, 38.** Owner of M&R Mechanical, a 2-truck HVAC shop in Phoenix.
Started four years ago after twelve years as a tech at a bigger outfit.
Married, two kids (7 and 4). Wife works full-time as a nurse.

One employee: **Carlos**, his cousin, a solid tech who won't touch paperwork.

Mike's stack: cell phone (his personal number *is* the business number), Google
Calendar, Housecall Pro Starter ($49/mo) for invoicing, QuickBooks
Self-Employed, a notebook in the truck, and his wife on weekends "for the
books."

Revenue: ~$680k last year. He wants a third truck but can't — there's no time
to hire, train, or dispatch. He's the bottleneck and he knows it.

His real job title is **dispatcher, CSR, estimator, bookkeeper, collections
agent, marketing manager, and HVAC technician.** Only the last one is the one
he wanted.

### Mike's Tuesday in August

A normal day. 102°F by 10am.

| Time | Without Serviceos | With Serviceos |
|------|-------------------|----------------|
| **5:45am** | Wakes up, checks phone. 6 missed calls overnight, 4 voicemails, 11 texts. Three calls are from the same 480 number — probably an emergency he lost to a competitor. Stomach drops. | Wakes up, checks phone. One text: *"Good morning. 7 calls overnight. 4 booked (Tue & Wed). 2 not a fit (out of area, I declined politely). 1 needs your call — Mrs. Alvarez, no AC, 2 small kids, you serviced her in May. Want me to dial her?"* Mike taps **Yes**. |
| **6:15am** | Drinks coffee while typing "sorry I missed your call" texts. Drafts an estimate from yesterday's job one-handed, in between making lunches. | Three drafted estimates waiting, each with a confidence score and the source — *"based on your call with Mr. Khan at 4:12pm yesterday + Carlos's notes."* Two look right — taps **Approve & Send**. Third has a part swap he wants to change — taps the line, dictates *"make that a 3-ton condenser, not 2.5."* All three quotes go out before 6:30. |
| **6:30am** | Leaves for first job. Phone rings on the way. Can't answer — driving. | Leaves. Phone rings — Serviceos answers in his shop's voice. Notification: *"David Chen wants a new install consult. I offered Thu 2pm or Fri 10am. He picked Thu — confirmed. Reply NO to undo."* He keeps driving. |
| **8:00am** | At first job, attic, gloves on, headlamp. Phone is ringing in his pocket. Can't answer. Doesn't know who it is. Tells himself he'll call back at lunch. (He won't.) | Phone buzzes once with a summary. He works. |
| **9:30am** | Mid-job. Customer asks: *"Can you also look at the unit in my rental property? Quote today?"* Mike says *"Yeah, text me the address."* He will forget. | Same ask. Mike says *"Text my office number — they'll get you a quote by end of day."* Customer texts. By 4pm, a draft quote is in Mike's queue, built from her account history and the model number he serviced six months ago. |
| **11:15am** | Between jobs. 9 missed calls. Eats a gas station burrito listening to voicemails. Two tire-kickers, three real, one vendor, three didn't leave messages. Calls back the three real ones. Two have already booked someone else. | Between jobs. Eats a real lunch. Opens Serviceos: *"3 jobs booked this morning. 2 estimates sent. $4,200 in approved invoices. 1 question for you."* The question: a customer asked about ductwork replacement — edge of his scope. Taps **No, refer out**. A polite decline goes out. |
| **12:30pm** | Tries to write the estimate for the rental property. Can't remember the model. Has to call the customer back. Voicemail. | The rental quote arrives with the model number Mike serviced in May, the customer's prior service history, and three scope options (repair / replace / install) with confidence scores. He approves the middle one. |
| **2:00pm** | Carlos calls from a job site: *"Mike, the customer's pissed, says we quoted $400 but the invoice was $650."* Mike pulls over, opens the notebook, can't find the original quote. Calls customer to apologize. Eats the $250. | Carlos calls. Mike asks Serviceos: *"What did we quote the Patel job?"* Reply in 4 seconds: *"$425 for diagnostic + capacitor. Invoice draft is $650 because Carlos added a contactor. Want me to text Carlos to confirm the scope change with the customer before invoicing?"* Mike taps **Yes**. Problem solved before it becomes a problem. |
| **4:30pm** | Finishing last scheduled job. Phone rings — *"My AC just stopped, 104 in here, my mom is on oxygen."* Mike is two hours away. Says he'll be there in two hours. He won't be. | Same call. Serviceos flags emergency + medical priority. **Does not try to book** — patches straight to Mike's cell with a 5-second context preface: *"Medical priority, no AC, elderly. Mrs. Hayes, your customer since 2024."* Mike answers driving, says *"I can be there at 8pm tonight."* |
| **6:00pm** | Drives home. Stops at parts store. Eats reheated dinner. Kids already in bath. | Drives home. Eats dinner with kids. Reads a bedtime story. |
| **7:30pm** | Kids in bed. Opens laptop. The "office hours" begin. 3 estimates, 4 invoices, 2 follow-ups on unpaid invoices, schedule tomorrow's jobs, respond to 11 texts. | Kids in bed. Opens phone. **End-of-day digest:** *"Today: 4 jobs done ($3,840 invoiced, $2,100 already paid via link). 5 quotes out ($18,400 in pipeline). 3 follow-ups sent on unpaid invoices — 1 paid, 1 promised this week, 1 silent (want me to call?). Tomorrow: 6 jobs, all confirmed. Carlos starts Garcia install 7am. You start Mrs. Alvarez 7:30. Nothing else needs your approval."* He taps **Looks good**. |
| **8:15pm** | Three estimates take 90 minutes — has to look up part prices and labor rates. Gets one wrong (forgets the diagnostic fee). | Reading to his daughter again. |
| **9:45pm** | Listens to voicemails. Calls back three. Two go to voicemail. One picks up and complains about Carlos being 20 minutes late. Mike apologizes for 15 minutes. | Already handled: Serviceos texted the late-arrival customer at 8:14am: *"Heads up — Carlos is running ~20 min late due to traffic. He'll text when 10 min out."* No complaint call happened. |
| **10:30pm** | Tries to chase two unpaid invoices. Drafts *"hi, just following up"* texts. Hates sending them. Doesn't send. | Already done at 2pm. Friendly, on-brand follow-ups with payment links. One paid within an hour. |
| **11:00pm** | Closes laptop. Lies awake thinking about the call he didn't return. Wonders how he'll hire a third tech if he can't keep up with two. | In bed at 9:45 with his wife. |

---

## Persona 2 — Jenna (solo plumber, Cleveland, frozen pipe season)

**Jenna Walsh, 41.** Owner-operator of Walsh Plumbing. **Solo** — one truck,
no employees. 18 years a plumber, 3 years on her own after a divorce. Wanted
control over her schedule for her 14-year-old son.

Jenna's stack: cell phone, a paper appointment book on the truck's dashboard,
Square for payments, a shared Google Drive folder of photos clients have
texted her, Stripe invoices she sends from her laptop at night.

Revenue: ~$340k. She doesn't want to grow into a fleet — she wants to stay
solo and have a life. The problem isn't ambition. The problem is that every
hour of admin is an hour not earning, an hour not with her son, or an hour of
sleep she doesn't get.

Jenna proves the pitch holds for a different shape of customer: **no
employees, no fleet, B2B referral relationships (property managers), and
emergencies that mean water damage now, not heat tomorrow.**

### Jenna's Tuesday in November

The first hard freeze of the season. Frozen pipes start at 4am.

| Time | Without Serviceos | With Serviceos |
|------|-------------------|----------------|
| **4:30am** | Phone starts ringing. By 6am she has 11 missed calls, 6 voicemails, and her son is asking what's for breakfast. She's already in the truck. | Phone buzzes once at 6am: *"11 calls since 4am. 8 are frozen pipe / burst, all in your area. I've sorted by severity (active leak > frozen no leak). Suggested route saves 90 min of driving. Want to see it?"* Jenna taps **Show me**. |
| **6:15am** | Picks the three closest because she can't think straight. Misses two bigger jobs in the same neighborhood. | Approves the route. Serviceos texts all 8 customers: *"This is Jenna's office. Confirmed Jenna will be at [address] at [time]. Reply STOP to cancel."* She drives. |
| **9:00am** | At customer #2. **Greenfield Property Management** calls — they manage 14 buildings, she handles their plumbing. *"Unit 4B at the Lakeshore is flooding, can you come now?"* She has to choose: ditch the current job, lose the customer relationship, or say no to Greenfield and lose a $4k/month account. Says yes to Greenfield. Walks off the current job with the leak half-fixed. | Same Greenfield call. Serviceos answers, recognizes the B2B account, says *"Jenna's on a job until 10:30. I can have her at Lakeshore by 10:45 — or I can call her if you need her sooner."* Property manager picks 10:45. Serviceos texts Jenna: *"Greenfield → Lakeshore 4B flooding. Booked you 10:45. I added it after your current job. OK?"* Jenna taps **OK**. Current customer doesn't get abandoned. |
| **11:30am** | Mid-job at Lakeshore, knee-deep. Customer from yesterday texts a photo of a leak under their sink: *"Is this bad? Can you come today?"* She can't even read the text. | Same customer texts the Serviceos number. Serviceos identifies them, looks at the photo, drafts a response: *"Looks like the supply line connection — probably $180-240 to fix. Jenna's slammed today, earliest I can offer is Thursday morning. Want me to book it?"* Customer says yes. Booked. Jenna sees the summary later. |
| **2:00pm** | Eats a granola bar driving to the next job. Realizes she forgot to invoice the morning's first customer. Will forget again. | Eats a sandwich at a real lunch break. Morning customer's invoice was drafted from her tech notes + the call recording, sent via SMS at 11:50am with a payment link. Paid before lunch. |
| **5:30pm** | Picks up her son from a friend's house, two hours late. Apologizes. Says "tomorrow." | Picks her son up at 5pm. He's in the truck for the last call of the day — she's running on time because she didn't have to manage admin between every job. |
| **7:00pm** | Dinner. Then 2 hours of: writing 4 quotes from memory, sending 6 invoices, returning voicemails, scrolling Facebook because she can't face it. | Dinner. Then the digest: *"Today: 9 jobs done (one of your highest revenue days — $4,200). 4 quotes drafted for your review. 2 invoices unpaid from last week — sent follow-ups, both promised payment Friday. Greenfield asked if you'd cover their on-call this weekend — declined politely on your behalf since you're with your son. Override?"* She taps **Looks good** and **Don't override**. |
| **9:30pm** | Falls asleep with phone on her chest waiting for the next emergency. | Watches a show with her son. Bed by 10:30. |

**What Jenna's day teaches us about the product:**
- **B2B account awareness matters.** Recognizing Greenfield (vs. a one-off
  call) changes the routing and the negotiation. The system needs accounts,
  not just customers.
- **Photo-driven quotes are first-class for plumbing.** The MMS-to-quote
  flow is required, not optional, for the plumbing vertical pack.
- **The pitch holds for solo operators.** "AI handles the business side"
  isn't more or less true when there's no Carlos — there's just no one else
  to delegate to, which makes it more urgent.
- **Severity-aware routing is a differentiator.** "Active leak > frozen no
  leak" isn't a feature ServiceTitan ships. It's vertical-pack intelligence.

---

## When Serviceos fails — Mike's bad Tuesday

This is the section we want to be most honest about. **No AI system is right
100% of the time, and the trust mechanism is not perfection — it's how the
system behaves when it's wrong.** ServiceTitan, HCP, and the AI receptionists
all paper over their failures. Our wedge is being the system that tells the
truth about itself.

A second Tuesday, three weeks later. Things go sideways.

| What went wrong | What the system does | How Mike handles it |
|----------------|---------------------|---------------------|
| **7:10am — Wrong quote.** Serviceos drafted an estimate for a customer using last year's labor rate (Mike raised rates in July and never told us). The quote was 18% low. | The estimate is in his approval queue, *not sent*. The line item shows the rate Serviceos used + a flag: *"⚠ Your last 3 approved estimates used a higher labor rate ($145/hr vs the $122/hr I used here). Want me to update?"* | Mike taps **Yes, update all future quotes to $145**. The next time the system drafts, it uses $145. **The mistake never reached the customer.** |
| **9:45am — Hallucinated part.** Serviceos suggests a "TXV-340 expansion valve" in a quote. That model doesn't exist for this unit. | The quote shows the part with a **low confidence** badge: *"I'm 62% sure this is the right part — Carlos mentioned 'the expansion valve' in his notes but I couldn't confirm the model from your inventory or prior jobs. Want me to ask Carlos?"* | Mike taps **Ask Carlos**. Serviceos texts Carlos: *"Which expansion valve on the Hernandez job?"* Carlos replies *"TXV-330."* Quote updates. Mike approves. |
| **11:00am — Missed emergency intent.** A caller said *"my AC stopped, it's hot"* in a flat voice. Serviceos booked it for tomorrow morning instead of escalating. Real situation: caller was an elderly woman who didn't want to "complain." | At 11:30am, Serviceos's review pass catches the booking using a second classifier (post-hoc review of all bookings for missed urgency). Sends Mike a flag: *"⚠ I booked Mrs. Park for tomorrow 9am for a no-AC call. She didn't sound urgent but it's 102° today and she's 78. Want me to offer her something today?"* | Mike taps **Yes, offer 6pm today.** Serviceos calls her back, offers 6pm, she accepts gratefully. **A future improvement: weight age + weather into emergency triage automatically.** |
| **1:30pm — Caller hung up.** Bad cell connection. Serviceos lost the caller after 11 seconds. | The system logs the missed call with the partial transcript and the caller's number. Within 60 seconds, it sends an SMS: *"Hi, this is M&R Mechanical's office. We lost you on the call — what can we help with? Text or call back, we're here."* Tells Mike: *"Caller dropped at 1:31pm, I texted them. I'll let you know what they say."* | Caller texts back. The conversation continues by SMS. Job gets booked. **Mike never sees this unless something goes wrong with it.** |
| **3:00pm — Customer game-plays.** Customer texts *"Your quote is too high, I'll go with [competitor] unless you knock 20% off."* | Serviceos does **not** negotiate. It replies *"Let me check with Mike on that one — I'll get back to you within the hour."* Then flags Mike: *"Pricing pushback from Mrs. Wagner. Quote was $1,420. She wants 20% off. Recommend: don't discount (she's a high-LTV customer who'll come back), offer a $100 courtesy off and a faster install slot. Your call."* | Mike taps **Offer $100 + Friday slot.** Serviceos sends. Customer takes it. |
| **5:00pm — A genuinely bad outcome.** Carlos no-showed a job (sick). Serviceos didn't know. Customer waited 90 minutes, left a 1-star Google review at 4:55pm. | Serviceos sees the review (via Google Business monitoring), flags it immediately: *"⚠ Mrs. Donovan left a 1-star review. Carlos missed the 3pm appointment. I didn't have his status — he didn't mark himself out sick in the app. Want me to draft a public response and a private apology, and propose a free service credit?"* | Mike taps **Yes**. Serviceos drafts both. Mike reads, tweaks one line, approves. Within an hour the public response is up and Mrs. Donovan got a personal text from Mike + a credit. Two days later, she updates her review to 4 stars. **Lesson: build a one-tap "I'm out" status for techs.** |
| **9:30pm — End-of-day, what I got wrong.** | The digest has a new section: *"Things I wasn't sure about today (3): the TXV-340 part (you corrected me — saved). Mrs. Park's urgency (you caught it — booked her in). Mrs. Wagner's pricing pushback (you decided — I won't negotiate without you). I'm getting better at the labor rate piece (no more rate mistakes since you updated it). One thing for tomorrow: Carlos's no-show — can we add a one-tap 'I'm out' button for techs?"* | Mike replies *"Yes, build that."* Serviceos files it as a feature request to the team. |

**What Mike's bad day teaches us about the product:**
- **Every AI output ships with a confidence signal.** Not a percentage on
  every line — surfaced only where it matters (parts, prices, urgency calls).
- **Self-review pass on every booking.** A cheaper classifier reviews the
  bookings the primary system made and flags anomalies. This is the
  "supervisor agent" pattern.
- **Never negotiate without a human.** AI never discounts, never commits to
  scope changes, never promises a person. Those decisions cost real money or
  trust, so they route through Mike.
- **Dropped calls always get an SMS recovery.** Voice failure → text fallback
  is automatic, not a separate feature.
- **Reputation monitoring is core.** Google review monitoring with one-tap
  draft response is shipped from day one.
- **The system surfaces its own uncertainty.** The end-of-day digest has a
  "what I wasn't sure about" section. This is the trust differentiator.
  Receptionists like Rosie/Goodcall never tell you what they got wrong.

---

## Scope discipline

This pitch will draw requests we have to say no to.

**In scope (now):**
- Inbound call answering and booking, with severity/B2B-account awareness
- SMS triage and replies in the shop's voice
- Photo-to-quote (plumbing) and call-to-quote (HVAC)
- Estimate drafting from call recordings + customer history
- Invoice drafting from completed jobs + tech notes
- Payment link generation and unpaid-invoice follow-up
- Schedule visibility, customer reminders, late-arrival heads-ups
- End-of-day digest with a "what I wasn't sure about" section
- Google review monitoring with draft-response approval
- One-tap "I'm out" status for techs
- Audit trail of every AI action

**Later (post product-market fit):**
- Outbound marketing (review requests, win-back, seasonal tune-up reminders)
- Maintenance agreement management
- Parts ordering from suppliers
- Multi-location dispatch optimization
- Recruiting / hiring assistance
- Equipment lifecycle tracking from photos
- Vertical packs beyond HVAC + plumbing

**Never (not our job):**
- Tax filing
- Payroll calculation (we surface hours; QuickBooks/Gusto pays)
- Legal advice
- Vendor price negotiation
- HR / firing decisions
- Discounting or scope-change commitments without owner approval
- Anything that requires the owner to log into a separate dashboard for >30 seconds

---

## What this forces on the product

If we commit to Mike's good Tuesday, Jenna's Tuesday, *and* Mike's bad
Tuesday, the following are no longer up for debate:

1. **Primary interface is SMS.** A web app exists for audit and configuration,
   but no daily action requires opening it. If the owner has to open the app
   to do their job, we failed.

2. **End-of-day digest is the dashboard.** A 6–9pm text summary, with a
   *"what I wasn't sure about today"* section. No real-time charts.

3. **One-tap approvals with dictation edits.** Every proposal is a single SMS
   with **Approve / Edit / Reject**. Edits accept voice dictation. No forms.

4. **Confidence is surfaced, not hidden.** Where the system is unsure (parts,
   prices, urgency, model numbers), the doubt is visible to the owner — and
   updated based on owner feedback.

5. **A second classifier reviews every booking and quote** for missed urgency,
   pricing anomalies, and out-of-pattern decisions. The "supervisor agent"
   catches what the primary model misses.

6. **Emergency intent overrides automation.** Urgency + vulnerability signals
   (medical, age, weather, water-damage-in-progress) route to the owner's
   phone immediately. Voice triage, not booking.

7. **The system never discounts or promises scope changes.** Those route
   through the owner with a recommendation.

8. **Dropped calls trigger automatic SMS recovery.** Voice → text fallback is
   built in.

9. **B2B account recognition is first-class.** Property managers, real-estate
   agents, and repeat commercial accounts are routed differently than
   one-off residential calls.

10. **Vertical packs matter:** plumbing needs MMS-to-quote and severity
    triage. HVAC needs equipment history and seasonal load awareness. The
    architecture supports both without forks.

11. **Google review monitoring with draft-response approval is shipped from
    day one.** Reputation recovery is part of the back office.

12. **Brand voice is configurable, then locked.** Every AI utterance —
    calls, texts, invoices, follow-ups, review responses — sounds like the
    shop.

13. **Every AI mistake is a learning event.** The owner's correction updates
    the system. The digest reports back what the system has learned.

14. **No feature ships that adds admin work to the owner's day.** The litmus
    test.

---

## How to use this document

- **Engineering**: When you're about to build a feature, find where in Mike's
  or Jenna's day it shows up. If it doesn't show up — or doesn't move a
  moment from left to right, or doesn't address a failure mode — it's the
  wrong feature.
- **Design**: Every screen and SMS should pass the *"would Mike, in the
  attic, on a hot day, with gloves on, find this useful in 5 seconds?"* test.
  The Jenna analog: *"would Jenna, kneeling in a flooded basement, with
  cold hands, find this useful in 5 seconds?"*
- **Marketing**: The pitch deck opens with Mike's without-column. Page 2 is
  the with-column. Page 3 is the bad-day section (the trust slide). Page 4
  is pricing. That's the deck.
- **Sales**: Read the without-column to a prospect. Stop after each row. Ask
  *"is this you?"* You'll know in three minutes whether they're an ICP.
- **Customer research**: Read the without-columns to 5 owner-operators each
  (HVAC and plumbing). Ask what's wrong, what's missing, what's the worst
  part. Their answers become the next version of this document.

This document is versioned. When it changes, the product changes.
