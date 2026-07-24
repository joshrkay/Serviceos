# Rivet — Customer Communications Spec

> Reference spec. Runtime is `/goal comms`. Supersedes the flat `customer` primitive in `RIVET_OPERATION_CONTRACTS.md` §5.4 — see §7 migration.

---

## 1. Data Model

```
ACCOUNT ──┬── CONTACT (person)      ← communications thread here
          ├── LOCATION (property)   ← jobs thread here
          └── billing               ← invoices, estimates, payment methods
```

**Account** — billing entity. Owns invoices, estimates, payment methods, terms, balance.
**Contact** — a person. Owns phone(s), email(s), channel preference, consent state, communication history.
**Location** — a property. Owns jobs, equipment records, access notes, service history.

**Relationships**
- Account has N Contacts, N Locations
- Contact may be scoped to specific Locations (tenant at one of four properties)
- Location has exactly one billing Account
- **A Contact may belong to multiple Accounts** — a property manager serving three owners. This breaks any model assuming a single parent and it's common enough to design for.

**Contact roles:** owner · tenant · property_manager · billing/AP · site_contact · other. Multiple roles per contact permitted.

**The canonical case this exists for:** landlord, tenant, property manager on one job. The person who calls, the person on site, and the person who pays are three humans with three phone numbers and different entitlements to information.

### Entitlement
A tenant may know the appointment window. A tenant may **not** see the invoice amount, the account balance, or other properties on the account. Entitlement is a property of the Contact's role, checked at read time — not a UI concern.

---

## 2. Resolution

`customer_ref` splits into three slot types. Type is inferred from operation, not from the utterance.

| Operation class | Resolves to |
|---|---|
| invoice, estimate, payment, balance | **Account** |
| job, schedule, dispatch, equipment | **Location** |
| message, call, email | **Contact** |

**New ambiguity — inbound call to Location.** Caller ID matches a Contact → Account → N Locations. One location resolves silently; more than one **must ask**. Never assume most-recent-serviced.

**New ambiguity — outbound to Contact.** "Send the invoice to Henderson" resolves the Account; the recipient Contact is the billing role. If no billing contact exists, ask. Never default to primary.

**Cross-Account contacts.** A property manager's inbound call is ambiguous across accounts by definition. Resolve by Location if stated, else ask. Never rank.

---

## 3. Unified Timeline

One chronological record per Account, filterable by Contact, Location, or Job.

Entry types: call (recording + transcript) · SMS in/out · email in/out · system events (invoice sent, job scheduled, payment received) · notes · commitments.

**I9 applies hard.** "What's the history with Henderson" on a five-year account is hundreds of entries. The agent summarizes and offers to narrow; it never enumerates.

**Threading:** SMS by phone pair; email by `Message-ID` / `In-Reply-To` / `References`; calls standalone; all joined to the Account timeline. A reply resolves within its own channel thread — cross-channel reply requires explicit channel selection.

---

## 4. Channel Selection

Outbound channel order: **explicit instruction → Contact preference → last channel that Contact used → account default.**

Never guess on R2. If the channel is unresolved and the operation is irreversible, ask.

**Cross-channel reply is the misresolution hazard.** "Reply to Henderson" with an open SMS thread, an unread email, and a voicemail is three-way ambiguous. Wrong resolution sends the message in the wrong *medium* — and with multiple Contacts per Account, potentially to the wrong person. A reply intended for the property manager landing in the tenant's SMS is a privacy failure, not a UX one.

---

## 5. Email

**Sending** — domain auth (SPF, DKIM, DMARC), bounce and complaint handling into a global suppression list, per-tenant sending identity. See D14 on shared vs per-tenant domain.

**Inbound** — MX or forwarding, parsed to the Contact by From address, unmatched addresses to a review queue rather than auto-created contacts.

**Untrusted content (I13).** Inbound email bodies carry the same provenance flag as S1 transcripts and may never enter an S2 agent context as instruction-eligible. Attachments add a vector SMS doesn't have: scan, size-cap, and never execute or parse-with-side-effects.

**CAN-SPAM vs transactional.** Invoice, estimate, appointment confirmation, and payment receipt are transactional and exempt from unsubscribe requirements. Marketing, review requests, and re-engagement are commercial and are not. Misclassifying commercial as transactional is the compliance failure here. Classification is per-template, set at creation, and immutable after send.

---

## 6. Recording, Consent, Retention

**Consent.** Roughly a dozen states require all-party consent — CA, IL, WA, PA, MA, MD, MT, NV, NH, OR, FL, CT among them. A one-party-consent contractor still receives calls from two-party states. **Announcement precedes the pipeline**, not the recording: ASR needs audio from the first syllable, so the disclosure must play before capture begins.

**Retention.** Audio, transcripts, and derived data (summaries, extracted commitments, embeddings) are PII with a retention clock. Deletion on request must reach **all four**, not just the audio file. A deletion capability that misses derived data is not a deletion capability.

**Discovery.** Recordings are discoverable in litigation against the contractor. This is their exposure, not only Rivet's, and it belongs in onboarding disclosure.

**PCI.** Per D13, no card number should ever reach a transcript. If one does, that recording store becomes PCI-scoped — detect and redact rather than assume compliance holds.

---

## 7. Commitment Extraction

Deriving obligations from conversation: *"call me back Thursday," "send me the quote tonight," "I'll be home after 4."*

**The failure mode has no error state.** A missed extraction means the customer was told someone would call, nobody did, and nothing threw. They don't complain — they just don't call again.

Design: extract with confidence scoring; high-confidence creates a task; low-confidence surfaces for operator review; **never silently discard**. An unreviewed low-confidence extraction is itself a queue item. Every commitment links to its source timeline entry so the operator can hear the actual words.

---

## 8. Migration Impact

Contracts in `RIVET_OPERATION_CONTRACTS.md` assuming a flat customer, requiring rework:

| Affected | Change |
|---|---|
| §2 `customer_ref` | Splits into `account_ref`, `contact_ref`, `location_ref` |
| CUS-001 create | Now creates or attaches Account + Contact + Location; three-way dedupe |
| CUS-002 edit | Scoped per entity type; phone edit is Contact-level |
| #6 merge | Merge at which level? Contacts, Accounts, or both — see D16 |
| #7 add_service_location | Becomes a first-class Location under Account |
| INB-002 auto-schedule | Adds Location resolution when Account has >1 |
| MSG-001/002 | Adds Contact resolution and entitlement check |
| INV/EST/PAY | Recipient is billing Contact, not "the customer" |
| I1 tenant scoping | Now tenant → Account → Contact/Location; deeper, more leak surface |

---

## 9. Decisions

| ID | Decision |
|---|---|
| **D14** | Email sending domain — shared (instant onboarding, pooled reputation risk) or per-tenant (protected reputation, DNS setup fights the 15-min S-1 target) |
| **D15** | Recording consent posture — announce on every call, or geo-conditional by caller area code (unreliable; VoIP and ported numbers defeat it) |
| **D16** | Merge semantics under the new model — Contact-level, Account-level, or both |
| **D17** | Retention period for audio, transcripts, and derived data; deletion SLA |
| **D18** | Weekend and after-hours communications — inbound is always received, but what's the response SLA, and does E2 route to on-call? |
| **D19** | Tenant entitlement defaults — what a tenant-role Contact may see without owner approval |
