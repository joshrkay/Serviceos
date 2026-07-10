/**
 * In-memory mailbox for the PreviewTransport (and, for demo visibility, a
 * mirror of ResendTransport sends). This is process-local state: it resets on
 * every cold start / new serverless instance / dev-server restart. It exists
 * purely so `/nurture-preview` can show "sends triggered this session" without
 * a database.
 */

export type TransportName = 'resend' | 'preview';

export interface MailboxEntry {
  id: string;
  at: string;
  to: string;
  from: string;
  emailId: string;
  subject: string;
  previewText: string;
  bodyHtml: string;
  bodyText: string;
  transport: TransportName;
}

const MAX_ENTRIES = 200;

const mailbox: MailboxEntry[] = [];

let counter = 0;

export function pushToMailbox(entry: Omit<MailboxEntry, 'id' | 'at'>): MailboxEntry {
  counter += 1;
  const full: MailboxEntry = {
    ...entry,
    id: `mail_${Date.now()}_${counter}`,
    at: new Date().toISOString(),
  };
  mailbox.unshift(full);
  if (mailbox.length > MAX_ENTRIES) {
    mailbox.length = MAX_ENTRIES;
  }
  return full;
}

/** Newest-first list of everything sent this process's lifetime. */
export function getMailbox(): readonly MailboxEntry[] {
  return mailbox;
}

/** Test/demo helper: wipe the mailbox (e.g. between test cases). */
export function clearMailbox(): void {
  mailbox.length = 0;
}
