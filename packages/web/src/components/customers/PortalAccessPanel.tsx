import React, { useCallback, useState } from 'react';
import { Copy, Link2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Field, Input, Select } from '../ui';
import { apiFetch } from '../../utils/api-fetch';

/**
 * Customer-portal access panel for the customer detail page.
 *
 * Two actions, both against the authed portal-session API:
 *
 *   1. "Generate portal link" — POST /api/portal-sessions mints a 30-day
 *      session and returns the plaintext link EXACTLY ONCE (the server
 *      stores only a hash), so the link is surfaced immediately with
 *      copy-to-clipboard.
 *   2. "Send portal link" — POST /api/portal-sessions/send mints a fresh
 *      session server-side and delivers it by SMS/email through the same
 *      consent/DNC-gated send machinery as estimate/invoice sends. A
 *      suppressed or failed send surfaces the API's message verbatim
 *      (e.g. no SMS consent) so the operator knows why nothing went out.
 */

interface MintedLink {
  url: string;
  expiresAt: string;
}

interface SentChannel {
  channel: 'sms' | 'email';
  recipient: string;
}

type SendChannel = 'sms' | 'email' | 'both';

async function errorMessageFrom(res: Response): Promise<string> {
  const json: { message?: string } | null = await res.json().catch(() => null);
  return json?.message ?? `HTTP ${res.status}`;
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function PortalAccessPanel({ customerId }: { customerId: string }) {
  const [link, setLink] = useState<MintedLink | null>(null);
  const [mintLoading, setMintLoading] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [channel, setChannel] = useState<SendChannel>('sms');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentChannels, setSentChannels] = useState<SentChannel[] | null>(null);

  const handleMint = useCallback(async () => {
    setMintLoading(true);
    setMintError(null);
    try {
      const res = await apiFetch('/api/portal-sessions', {
        method: 'POST',
        body: JSON.stringify({ customerId }),
      });
      if (!res.ok) throw new Error(await errorMessageFrom(res));
      const json: MintedLink = await res.json();
      setLink({ url: json.url, expiresAt: json.expiresAt });
      toast.success('Portal link created');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create portal link';
      setMintError(message);
      toast.error(message);
    } finally {
      setMintLoading(false);
    }
  }, [customerId]);

  const handleCopy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success('Portal link copied');
    } catch {
      toast.error('Could not copy — select the link text instead');
    }
  }, [link]);

  const handleSend = useCallback(async () => {
    setSendLoading(true);
    setSendError(null);
    setSentChannels(null);
    try {
      const res = await apiFetch('/api/portal-sessions/send', {
        method: 'POST',
        body: JSON.stringify({ customerId, channel }),
      });
      if (!res.ok) throw new Error(await errorMessageFrom(res));
      const json: { channelsSent: SentChannel[] } = await res.json();
      setSentChannels(json.channelsSent);
      toast.success('Portal link sent');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to send portal link';
      setSendError(message);
      toast.error(message);
    } finally {
      setSendLoading(false);
    }
  }, [channel, customerId]);

  return (
    <div className="flex flex-col gap-4" data-testid="portal-access-panel">
      <p className="text-sm text-muted-foreground">
        Give this customer secure self-service access to their estimates,
        invoices, jobs, and appointments. Links expire automatically.
      </p>

      <div className="flex flex-col gap-2">
        <div>
          <Button
            size="sm"
            variant="outline"
            loading={mintLoading}
            onClick={handleMint}
          >
            <Link2 size={14} className="mr-1.5" />
            Generate portal link
          </Button>
        </div>
        {mintError && (
          <p role="alert" className="text-sm text-destructive">
            {mintError}
          </p>
        )}
        {link && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Portal link"
                value={link.url}
                onFocus={(event) => event.target.select()}
              />
              <Button size="sm" variant="ghost" onClick={handleCopy}>
                <Copy size={14} className="mr-1.5" />
                Copy link
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Expires {formatExpiry(link.expiresAt)}. The link is shown once —
              copy it now or send it below.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-end gap-2">
          <Field label="Send channel" className="w-40">
            <Select
              aria-label="Send channel"
              value={channel}
              disabled={sendLoading}
              onChange={(event) => setChannel(event.target.value as SendChannel)}
            >
              <option value="sms">Text message</option>
              <option value="email">Email</option>
              <option value="both">Text + email</option>
            </Select>
          </Field>
          <Button size="sm" loading={sendLoading} onClick={handleSend}>
            <Send size={14} className="mr-1.5" />
            Send portal link
          </Button>
        </div>
        {sendError && (
          <p role="alert" className="text-sm text-destructive">
            {sendError}
          </p>
        )}
        {sentChannels && sentChannels.length > 0 && (
          <p className="text-sm text-foreground">
            Portal link sent via{' '}
            {sentChannels
              .map((c) => `${c.channel === 'sms' ? 'text' : 'email'} to ${c.recipient}`)
              .join(' and ')}
            .
          </p>
        )}
      </div>
    </div>
  );
}
