/**
 * The 8 nurture emails, transcribed from `nurture/emails/*.md` (frontmatter +
 * body) and `nurture/lifecycle-mapping.md` (trigger/delay/suppression). This
 * is the single source of typed truth the engine, tests, and the
 * `/nurture-preview` page all read from.
 *
 * Bodies are authored once as markdown (matching the .md files verbatim) and
 * rendered to bodyHtml/bodyText via markdown.ts, so the HTML/text copies can
 * never drift from each other.
 */
import { markdownBodyToHtml, markdownBodyToText } from './markdown';

/** Every merge field referenced anywhere in the 8 emails. Trial-summary fields
 * are product-data merges — never hardcode a value, never invent one. */
export const KNOWN_MERGE_FIELDS = [
  'first_name',
  'onboarding_url',
  'app_url',
  'restart_url',
  'fix_payment_url',
  'calls_answered',
  'bookings_approved',
  'estimates_drafted',
  'invoices_sent',
] as const;

export type MergeFieldName = (typeof KNOWN_MERGE_FIELDS)[number];

export type MergeData = Partial<Record<MergeFieldName, string>>;

/** Replace {{field}} placeholders with known merge data; unknown/missing
 * placeholders are left intact rather than silently blanked. */
export function renderMergeFields(template: string, data: MergeData): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, rawKey: string) => {
    const key = rawKey as MergeFieldName;
    if (KNOWN_MERGE_FIELDS.includes(key) && data[key] != null) {
      return String(data[key]);
    }
    return match;
  });
}

export type NurtureAnchorTrigger = 'trial_started' | 'canceled_or_trial_expired' | 'payment_failed';

/** Suppression predicates, evaluated against ContactState by engine.ts. Kept
 * as plain booleans (not a generic rule engine) because the mapping table in
 * lifecycle-mapping.md only ever combines these three conditions. */
export interface SuppressionRule {
  ifActivated?: boolean;
  ifCanceled?: boolean;
  ifConverted?: boolean;
}

export interface NurtureEmail {
  id: string;
  /** Position in the main trial_started drip (1-6), or null for off-lifecycle emails. */
  sequenceOrder: number | null;
  trigger: NurtureAnchorTrigger;
  /** Days after the anchor event before this email is due. 0 = immediate. */
  delayDays: number;
  subject: string;
  previewText: string;
  bodyHtml: string;
  bodyText: string;
  suppression: SuppressionRule;
  /** Human-readable suppression rule, verbatim-ish from lifecycle-mapping.md, for the preview page. */
  suppressionNote: string;
  /** Transactional emails (welcome, payment-failed) send regardless of marketing opt-out. */
  transactional: boolean;
}

interface RawEmail {
  id: string;
  sequenceOrder: number | null;
  trigger: NurtureAnchorTrigger;
  delayDays: number;
  subject: string;
  previewText: string;
  body: string;
  suppression: SuppressionRule;
  suppressionNote: string;
  transactional: boolean;
}

const RAW_EMAILS: RawEmail[] = [
  {
    id: 'welcome',
    sequenceOrder: 1,
    trigger: 'trial_started',
    delayDays: 0,
    subject: "You're in. Let's get your number live",
    previewText: "Your trial's on. One job today — hear your AI answer.",
    suppression: {},
    suppressionNote: 'None (always fires on trial start).',
    transactional: true,
    body: `Hey {{first_name}},

You're in. Your 14-day trial started today. No charge until day 15, and you can cancel any time before then.

Here's what the next 10 minutes look like. Four steps, all inside the app:

1. Business setup — name, hours, service area.
2. Price book — load your real prices so quotes come out right.
3. Brand voice — how your shop talks. This is what callers will hear.
4. Phone number — get your AI line live.

That's it. Once the number's live, you make a test call and hear your own shop answer.

One job for today: get your number live. Everything else can wait.

<a href="{{onboarding_url}}">Finish setup</a>

If you get stuck, just reply to this email. It comes to me.

Josh — founder, Rivet`,
  },
  {
    id: 'activation-nudge',
    sequenceOrder: 2,
    trigger: 'trial_started',
    delayDays: 1,
    subject: 'Call your own number today',
    previewText: 'Two minutes to hear your shop answer the phone.',
    suppression: { ifActivated: true, ifCanceled: true, ifConverted: true },
    suppressionNote:
      'Suppress if first_real_call recorded (activation already reached). Also suppress if canceled or trial_converted fired.',
    transactional: false,
    body: `Hey {{first_name}},

The fastest way to know if Rivet's for you: call your own number and listen.

Once your line is live, do this:

1. Open the app and finish the test-call step.
2. Call the number from your cell.
3. Listen. That's your shop's voice answering — the same one your real callers will get.

Ask it something a customer would ask. "You got anyone out my way tomorrow?" See how it handles it. Every booking it makes comes back to you for a one-tap OK first, so nothing goes out without you.

Most owners get this done in about two minutes. It's the moment it clicks.

<a href="{{onboarding_url}}">Make your test call</a>

Stuck on getting the number live? Reply here and I'll help.

Josh — founder, Rivet`,
  },
  {
    id: 'mid-trial-value',
    sequenceOrder: 3,
    trigger: 'trial_started',
    delayDays: 5,
    subject: "What your AI wasn't sure about",
    previewText: 'The digest that hands you your evenings back.',
    suppression: { ifCanceled: true },
    suppressionNote: 'Suppress if canceled fired.',
    transactional: false,
    body: `Hey {{first_name}},

Here's what a morning can look like with Rivet running. This is illustrative — one owner-operator's shape of day, not a promise:

Mike wakes up, checks his phone. Without help, that's 6 missed calls and a stomach drop. With Rivet, it's one text: "7 calls overnight. 4 booked. 2 weren't a fit — I declined politely. 1 needs your call." He taps yes and starts his day.

That's the idea. The phone gets answered while you sleep, and you get a summary instead of a mess.

Two things to check in your app:

- The nightly digest — your day's numbers, follow-up outcomes, and a "what I wasn't sure about" section.
- The approval queue — every draft the AI made, waiting for your one-tap OK.

Open last night's digest and read the "wasn't sure about" part. That's the honest core of how this works.

<a href="{{app_url}}">See your digest</a>

Josh — founder, Rivet`,
  },
  {
    id: 'honesty',
    sequenceOrder: 4,
    trigger: 'trial_started',
    delayDays: 8,
    subject: "How Rivet tells you when it's wrong",
    previewText: "No testimonials yet. Here's the honest version.",
    suppression: { ifCanceled: true },
    suppressionNote: 'Suppress if canceled fired.',
    transactional: false,
    body: `Hey {{first_name}},

I could fill this email with customer quotes. I won't — we just launched, and I'm not going to make them up.

So here's the real reason to trust it. It's built to tell you when it's unsure:

- Every action is a proposal. The AI drafts the booking, the quote, the invoice — you approve it with one tap. Nothing reaches a customer without you.
- A second agent double-checks the first. It reviews bookings and quotes for missed urgency or a price that looks off, and flags what smells wrong.
- It never negotiates. No discounts, no scope changes on its own. That decision comes to you.
- The nightly digest admits mistakes. There's a "what I wasn't sure about" section — the part most tools hide.

That's the whole pitch. Not that it's perfect. That it's honest when it isn't, and you're always the one who approves.

<a href="{{app_url}}">Open your approval queue</a>

Josh — founder, Rivet`,
  },
  {
    id: 'trial-ending',
    sequenceOrder: 5,
    trigger: 'trial_started',
    delayDays: 11,
    subject: '3 days left on your trial',
    previewText: "Here's what you keep, and how billing works.",
    suppression: { ifCanceled: true, ifConverted: true },
    suppressionNote:
      'Suppress if canceled or trial_converted fired (they already committed or already left).',
    transactional: false,
    body: `Hey {{first_name}},

Three days left on your trial. Quick, no-games rundown.

Billing starts on day 15. The card you added gets charged then — not before. Cancel any time before day 15 and you pay nothing.

What you keep on each plan:

- Solo — $299/mo. One truck, owner-operator.
- Shop — $499/mo. You plus a tech or two.
- Pro — $799/mo. The growing shop.

All plans: AI answers your phone 24/7, drafts your estimates and invoices, sends payment links, chases unpaid invoices, and hands you the nightly digest. Every action still comes to you for approval.

Nothing changes automatically — if the plan you're on fits, you don't have to do a thing. If you want a different tier, switch it in the app.

<a href="{{app_url}}">Manage your plan</a>

Questions about any of it? Reply here.

Josh — founder, Rivet`,
  },
  {
    id: 'convert-last-day',
    sequenceOrder: 6,
    trigger: 'trial_started',
    delayDays: 13,
    subject: "Last day — here's what Rivet did",
    previewText: 'A real count of your trial. Then your call.',
    suppression: { ifCanceled: true, ifConverted: true },
    suppressionNote: 'Suppress if canceled or trial_converted fired.',
    transactional: false,
    body: `Hey {{first_name}},

Last day of your trial. No countdown timer, no fake discount. Just the numbers.

Here's what Rivet did while you had it:

- Calls answered: {{calls_answered}}
- Bookings you approved: {{bookings_approved}}
- Estimates drafted: {{estimates_drafted}}
- Invoices sent: {{invoices_sent}}

That's real work that didn't land on you at 9pm.

Tomorrow is day 15, so billing starts unless you cancel. If it earned its keep, you don't need to do anything — it keeps running.

If it didn't, cancel in the app, no hard feelings. I'd genuinely like to know why — reply and tell me. That's how it gets better.

<a href="{{app_url}}">Keep it running</a>

Either way, thanks for giving it a shot.

Josh — founder, Rivet`,
  },
  {
    id: 'win-back',
    sequenceOrder: null,
    trigger: 'canceled_or_trial_expired',
    delayDays: 7,
    subject: "The door's still open",
    previewText: "One email. What's changed. No pressure.",
    suppression: { ifConverted: true },
    suppressionNote:
      'Suppress if trial_converted later fired (they came back on their own). Send once, ever.',
    transactional: false,
    body: `Hey {{first_name}},

You tried Rivet and it wasn't the fit — that's fine. This is the only win-back note I'll send. One email, then I'll leave you be.

I don't know exactly why it didn't stick for you. Maybe the setup was a hassle. Maybe your slow season made it hard to tell. Maybe it just wasn't there yet.

We're shipping every week, so "not yet" may already be "now." If you want to see where it's at, your setup is still saved — you can pick up a fresh trial where you left off, no re-doing the price book.

<a href="{{restart_url}}">Start a new trial</a>

And if the honest answer is it's just not for you, reply and tell me what was missing. That's worth more to me than another signup.

Door stays open either way.

Josh — founder, Rivet`,
  },
  {
    id: 'payment-failed',
    sequenceOrder: null,
    trigger: 'payment_failed',
    delayDays: 0,
    subject: "Your payment didn't go through",
    previewText: 'Quick fix so your AI keeps answering the phone.',
    suppression: {},
    suppressionNote:
      'Suppress if payment succeeds on retry before send. De-dupe: max 1 per failed-payment event; do not re-send on repeated retries within 24h.',
    transactional: true,
    body: `Hey {{first_name}},

Heads up — we tried to run your card for Rivet and it didn't go through. Happens all the time. Expired card, a hold, a new number.

Nothing's shut off yet. Your AI is still answering your phone. But if the payment doesn't clear, your account will pause, and calls stop getting handled — so let's fix it before that.

Takes about a minute:

<a href="{{fix_payment_url}}">Update your card</a>

We'll retry automatically once it's updated. If the card's fine and this keeps happening, reply here and I'll dig into it with you.

Josh — founder, Rivet`,
  },
];

export const NURTURE_SEQUENCES: readonly NurtureEmail[] = RAW_EMAILS.map((raw) => ({
  id: raw.id,
  sequenceOrder: raw.sequenceOrder,
  trigger: raw.trigger,
  delayDays: raw.delayDays,
  subject: raw.subject,
  previewText: raw.previewText,
  bodyHtml: markdownBodyToHtml(raw.body),
  bodyText: markdownBodyToText(raw.body),
  suppression: raw.suppression,
  suppressionNote: raw.suppressionNote,
  transactional: raw.transactional,
}));

/** The main trial_started drip, in send order (emails 1-6). */
export const TRIAL_DRIP_SEQUENCE: readonly NurtureEmail[] = NURTURE_SEQUENCES.filter(
  (email) => email.trigger === 'trial_started',
).sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0));

export const WIN_BACK_EMAIL: NurtureEmail = NURTURE_SEQUENCES.find(
  (email) => email.id === 'win-back',
)!;

export const PAYMENT_FAILED_EMAIL: NurtureEmail = NURTURE_SEQUENCES.find(
  (email) => email.id === 'payment-failed',
)!;

export function getEmailById(id: string): NurtureEmail | undefined {
  return NURTURE_SEQUENCES.find((email) => email.id === id);
}
