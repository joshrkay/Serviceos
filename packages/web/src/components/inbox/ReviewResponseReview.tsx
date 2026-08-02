/**
 * U6 — review-response approval card for the inbox.
 *
 * A `review_response_proposal` bundles up to three independently-approvable
 * sub-actions (shared/src/contracts/review-response-proposal.ts):
 *
 *   1. publicResponse  — reply posted publicly to the Google Business Profile
 *   2. privateFollowUp — 1:1 email/SMS to the matched customer (nullable)
 *   3. serviceCredit   — integer-cents account credit (nullable)
 *
 * Every component's `approved` flag is drafted `false` (reputation/
 * build-proposal.ts), and the execution handler dispatches PER FLAG — so a
 * bare POST /approve would "succeed" while posting nothing. This card is the
 * missing approval surface: it shows the exact words that would go public,
 * lets the owner include/exclude each component, and the InboxPage flips the
 * chosen flags through the EXISTING edit endpoint (PUT /api/proposals/:id)
 * before approving — the same edit-before-approve path the service-address
 * completion uses, so no API changes are needed.
 *
 * Pure helpers live here (malformed-safe, mirroring the mobile
 * `reviewResponseView` in packages/mobile/src/proposals/proposalReview.ts) so
 * they unit-test without a renderer.
 */
import { formatCurrency } from '../../utils/currency';

export interface ReviewResponsePublicView {
  text?: string;
  approved?: boolean;
}
export interface ReviewResponsePrivateView {
  customerId?: string;
  channel?: string;
  body?: string;
  approved?: boolean;
}
export interface ReviewResponseCreditView {
  customerId?: string;
  amountCents?: number;
  approved?: boolean;
}

/** The review-response keys of an inbox proposal payload (loosely typed —
 *  the inbox serializes whatever was stored; render malformed-safe). */
export interface ReviewResponsePayloadView {
  classification?: string;
  publicResponse?: ReviewResponsePublicView;
  privateFollowUp?: ReviewResponsePrivateView | null;
  serviceCredit?: ReviewResponseCreditView | null;
}

/** Which components the approver wants executed on approve. */
export interface ReviewResponseSelection {
  publicResponse: boolean;
  privateFollowUp: boolean;
  serviceCredit: boolean;
}

const CLASSIFICATION_LABEL: Record<string, string> = {
  praise: 'Praise',
  specific_complaint: 'Specific complaint',
  vague_complaint: 'Vague complaint',
};

function publicReplyText(payload: ReviewResponsePayloadView | undefined): string {
  const text = payload?.publicResponse?.text;
  return typeof text === 'string' ? text.trim() : '';
}

function hasPrivateFollowUp(payload: ReviewResponsePayloadView | undefined): boolean {
  const priv = payload?.privateFollowUp;
  return !!priv && typeof priv.body === 'string' && priv.body.trim().length > 0;
}

function hasServiceCredit(payload: ReviewResponsePayloadView | undefined): boolean {
  const credit = payload?.serviceCredit;
  return !!credit && typeof credit.amountCents === 'number' && credit.amountCents > 0;
}

/**
 * Does this payload carry a renderable review-response draft? Gated on the
 * public reply text — a payload without it has nothing to review (mirrors the
 * mobile view's null case). The proposal-type gate lives at the call site.
 */
export function needsReviewResponseReview(
  payload: ReviewResponsePayloadView | undefined,
): boolean {
  return publicReplyText(payload).length > 0;
}

/**
 * Default selection: every component the draft carries is included, so one
 * tap of Approve executes everything the card shows. The toggles exist to
 * EXCLUDE (e.g. post the reply but skip the credit) — mix-and-match is the
 * contract's stated review-time affordance.
 */
export function initialReviewResponseSelection(
  payload: ReviewResponsePayloadView | undefined,
): ReviewResponseSelection {
  return {
    publicResponse: needsReviewResponseReview(payload),
    privateFollowUp: hasPrivateFollowUp(payload),
    serviceCredit: hasServiceCredit(payload),
  };
}

/** True when the selection would execute at least one present component. */
export function anyReviewComponentSelected(
  payload: ReviewResponsePayloadView | undefined,
  selection: ReviewResponseSelection,
): boolean {
  return (
    (selection.publicResponse && needsReviewResponseReview(payload)) ||
    (selection.privateFollowUp && hasPrivateFollowUp(payload)) ||
    (selection.serviceCredit && hasServiceCredit(payload))
  );
}

/**
 * Build the payload edits that flip each component's `approved` flag to the
 * approver's selection. Components are sent WHOLE (stored fields spread +
 * the new flag) because the edit endpoint merges top-level keys and then
 * re-validates the full payload against the Zod contract — a partial
 * component object would fail validation. Returns null when every stored
 * flag already matches (no PUT needed).
 */
export function reviewResponseEditsFrom(
  payload: ReviewResponsePayloadView | undefined,
  selection: ReviewResponseSelection,
): Record<string, unknown> | null {
  if (!payload) return null;
  const edits: Record<string, unknown> = {};

  const pub = payload.publicResponse;
  if (pub && needsReviewResponseReview(payload) && Boolean(pub.approved) !== selection.publicResponse) {
    edits.publicResponse = { ...pub, approved: selection.publicResponse };
  }
  const priv = payload.privateFollowUp;
  if (priv && hasPrivateFollowUp(payload) && Boolean(priv.approved) !== selection.privateFollowUp) {
    edits.privateFollowUp = { ...priv, approved: selection.privateFollowUp };
  }
  const credit = payload.serviceCredit;
  if (credit && hasServiceCredit(payload) && Boolean(credit.approved) !== selection.serviceCredit) {
    edits.serviceCredit = { ...credit, approved: selection.serviceCredit };
  }

  return Object.keys(edits).length > 0 ? edits : null;
}

/** One include/exclude toggle row. `min-h-11` — glove-friendly tap target. */
function ComponentToggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      htmlFor={id}
      data-testid="review-component-toggle"
      className="flex min-h-11 cursor-pointer items-center gap-2 py-1"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-primary"
      />
      <span className="min-w-0 text-sm text-foreground">
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * The review card body: the drafted public reply verbatim (it posts publicly,
 * so the approver must see the exact words), plus the optional follow-up and
 * credit, each with an include/exclude toggle. Long unbroken tokens wrap
 * (`break-words` + `whitespace-pre-wrap`) so a runaway word can't push the
 * row past a 320px viewport.
 */
export function ReviewResponseReview({
  payload,
  selection,
  onChange,
  idPrefix,
}: {
  payload: ReviewResponsePayloadView;
  selection: ReviewResponseSelection;
  onChange: (next: ReviewResponseSelection) => void;
  idPrefix: string;
}) {
  const reply = publicReplyText(payload);
  if (!reply) return null;

  const classification = payload.classification
    ? (CLASSIFICATION_LABEL[payload.classification] ?? payload.classification)
    : null;
  const priv = hasPrivateFollowUp(payload) ? payload.privateFollowUp! : null;
  const credit = hasServiceCredit(payload) ? payload.serviceCredit! : null;
  const nothingSelected = !anyReviewComponentSelected(payload, selection);

  return (
    <div className="mt-2 space-y-2" data-testid="review-response-review">
      {classification && (
        <span
          data-testid="review-classification"
          className="inline-flex w-fit items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {classification}
        </span>
      )}

      <div className="min-w-0">
        <ComponentToggle
          id={`${idPrefix}-review-public`}
          checked={selection.publicResponse}
          onChange={(next) => onChange({ ...selection, publicResponse: next })}
          label="Post public reply"
          hint="Posts publicly to your Google Business Profile"
        />
        <p
          data-testid="review-public-draft"
          className="whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
        >
          {reply}
        </p>
      </div>

      {priv && (
        <div className="min-w-0">
          <ComponentToggle
            id={`${idPrefix}-review-private`}
            checked={selection.privateFollowUp}
            onChange={(next) => onChange({ ...selection, privateFollowUp: next })}
            label={`Send private ${priv.channel === 'sms' ? 'text' : (priv.channel ?? 'message')} follow-up`}
          />
          <p
            data-testid="review-private-draft"
            className="whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
          >
            {priv.body!.trim()}
          </p>
        </div>
      )}

      {credit && (
        <ComponentToggle
          id={`${idPrefix}-review-credit`}
          checked={selection.serviceCredit}
          onChange={(next) => onChange({ ...selection, serviceCredit: next })}
          label={`Apply ${formatCurrency(credit.amountCents!)} service credit`}
        />
      )}

      {/* The handler dispatches per-flag — approving with nothing selected
          would mark the proposal executed while posting nothing. The Approve
          button is disabled in this state; this line says why. */}
      {nothingSelected && (
        <p data-testid="review-nothing-selected" className="text-xs text-warning">
          Nothing selected — approving would post nothing. Include at least one
          part, or reject the draft.
        </p>
      )}
    </div>
  );
}
