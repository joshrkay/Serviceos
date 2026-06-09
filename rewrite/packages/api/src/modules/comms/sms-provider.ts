export interface SmsSendRequest {
  to: string;
  from: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  send(request: SmsSendRequest): Promise<{ externalId: string | null }>;
}

/** Dev/test provider: records sends in memory and logs metadata only (no PII bodies). */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly sent: SmsSendRequest[] = [];

  async send(request: SmsSendRequest): Promise<{ externalId: string | null }> {
    this.sent.push(request);
    console.log('[sms] outbound', { to: request.to, from: request.from, chars: request.body.length });
    return { externalId: `console-${this.sent.length}` };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  async send(request: SmsSendRequest): Promise<{ externalId: string | null }> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const params = new URLSearchParams({ To: request.to, From: request.from, Body: request.body });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    );
    if (!response.ok) {
      throw new Error(`twilio send failed: ${response.status}`);
    }
    const body = (await response.json()) as { sid?: string };
    return { externalId: body.sid ?? null };
  }
}
