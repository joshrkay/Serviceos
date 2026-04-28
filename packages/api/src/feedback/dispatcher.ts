export interface FeedbackDispatchInput {
  to: string;
  body: string;
}

export interface FeedbackDispatcher {
  send(input: FeedbackDispatchInput): Promise<void>;
}

export class NoopFeedbackDispatcher implements FeedbackDispatcher {
  async send(_input: FeedbackDispatchInput): Promise<void> {
    // Intentionally no-op in environments without SMS credentials.
  }
}

export interface SmsProviderDispatcherOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  apiBaseUrl?: string;
}

export class SmsProviderFeedbackDispatcher implements FeedbackDispatcher {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly apiBaseUrl: string;

  constructor(options: SmsProviderDispatcherOptions) {
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.fromNumber = options.fromNumber;
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.TWILIO.com/2010-04-01';
  }

  async send(input: FeedbackDispatchInput): Promise<void> {
    const body = new URLSearchParams({
      To: input.to,
      From: this.fromNumber,
      Body: input.body,
    });

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await fetch(
      `${this.apiBaseUrl}/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SMS provider send failed (${response.status}): ${text}`);
    }
  }
}
