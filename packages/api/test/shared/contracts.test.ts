import {
  healthResponseSchema,
  errorResponseSchema,
  createTenantSchema,
  createUserSchema,
  uploadFileSchema,
  createAiRunSchema,
  createMessageSchema,
  delayAcknowledgmentSchema,
  updateSettingsSchema,
  createJobSchema,
  scheduleJobSchema,
  reassignJobSchema,
  unscheduleJobSchema,
} from '../../src/shared/contracts';
import { validate } from '../../src/shared/validation';
import { AppError, ValidationError, toErrorResponse } from '../../src/shared/errors';

describe('updateSettingsSchema — call routing + review URLs', () => {
  it('accepts escalationSettings so CallRoutingSheet preferences persist', () => {
    const result = updateSettingsSchema.safeParse({
      escalationSettings: {
        channel_sms: false,
        trigger_llm_sentiment: true,
        llm_sentiment_threshold: 0.8,
        after_hours_voice_mode: 'ai_answering',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalationSettings).toEqual({
        channel_sms: false,
        trigger_llm_sentiment: true,
        llm_sentiment_threshold: 0.8,
        after_hours_voice_mode: 'ai_answering',
      });
    }
  });

  it('rejects an invalid after_hours_voice_mode', () => {
    const result = updateSettingsSchema.safeParse({
      escalationSettings: { after_hours_voice_mode: 'carrier_pigeon' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the milestoneBillingEnabled opt-in (reachable via PATCH /api/settings)', () => {
    // Zod strips unknown keys, so without this field the toggle could only be
    // set by editing the DB. It must survive parsing alongside the sibling
    // billing opt-ins.
    const result = updateSettingsSchema.safeParse({
      milestoneBillingEnabled: true,
      batchInvoiceEnabled: true,
      autoInvoiceOnCompletion: true,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.milestoneBillingEnabled).toBe(true);
  });

  it('accepts review URLs and normalizes empty strings to null', () => {
    const result = updateSettingsSchema.safeParse({
      googleReviewUrl: 'https://g.page/r/abc',
      yelpReviewUrl: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.googleReviewUrl).toBe('https://g.page/r/abc');
      expect(result.data.yelpReviewUrl).toBeNull();
    }
  });

  it('normalizes a whitespace-only review URL to null instead of rejecting it', () => {
    const result = updateSettingsSchema.safeParse({ googleReviewUrl: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.googleReviewUrl).toBeNull();
    }
  });

  it('trims surrounding whitespace around a valid review URL', () => {
    const result = updateSettingsSchema.safeParse({ googleReviewUrl: '  https://g.page/r/abc  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.googleReviewUrl).toBe('https://g.page/r/abc');
    }
  });

  it('rejects non-https review URL schemes (javascript:/data:/http:)', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://g.page/r/abc']) {
      expect(updateSettingsSchema.safeParse({ googleReviewUrl: bad }).success, bad).toBe(false);
    }
  });

  it('accepts a valid Polly voice id and rejects XML-metachar voice ids', () => {
    expect(updateSettingsSchema.safeParse({ ttsVoiceEs: 'Polly.Lupe-Neural' }).success).toBe(true);
    expect(updateSettingsSchema.safeParse({ ttsVoiceEs: 'a"><Say>x' }).success).toBe(false);
  });

  it('rejects a malformed review URL', () => {
    const result = updateSettingsSchema.safeParse({ googleReviewUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });
});

describe('P0-005 — Backend service skeleton and shared contracts', () => {
  it('happy path — healthResponseSchema validates correct input', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      version: '1.0.0',
      environment: 'dev',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('validation — healthResponseSchema rejects invalid status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'unknown',
      version: '1.0.0',
      environment: 'dev',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('happy path — createUserSchema validates correct input', () => {
    const result = createUserSchema.safeParse({
      email: 'test@example.com',
      role: 'technician',
    });
    expect(result.success).toBe(true);
  });

  it('validation — createUserSchema rejects invalid role', () => {
    const result = createUserSchema.safeParse({
      email: 'test@example.com',
      role: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('validation — validate throws ValidationError on bad data', () => {
    expect(() =>
      validate(createTenantSchema, { ownerEmail: 'not-email', name: '' })
    ).toThrow(ValidationError);
  });

  it('happy path — validate passes on good data', () => {
    const result = validate(createTenantSchema, {
      ownerEmail: 'test@example.com',
      name: 'My Org',
    });
    expect(result.ownerEmail).toBe('test@example.com');
  });

  it('happy path — toErrorResponse formats AppError', () => {
    const err = new AppError('TEST_ERROR', 'Something went wrong', 422);
    const response = toErrorResponse(err);
    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe('TEST_ERROR');
  });

  it('happy path — toErrorResponse formats unknown error', () => {
    const response = toErrorResponse(new Error('random'));
    expect(response.statusCode).toBe(500);
    expect(response.body.error).toBe('INTERNAL_ERROR');
  });

  it('happy path — delayAcknowledgmentSchema accepts fixed delay options', () => {
    const result = delayAcknowledgmentSchema.safeParse({
      appointmentId: 'apt-1',
      isRunningBehind: true,
      delayMinutes: 20,
      reasonCode: 'traffic',
    });
    expect(result.success).toBe(true);
  });

  it('validation — delayAcknowledgmentSchema rejects unsupported delay values', () => {
    const result = delayAcknowledgmentSchema.safeParse({
      appointmentId: 'apt-1',
      isRunningBehind: true,
      delayMinutes: 25,
    });
    expect(result.success).toBe(false);
  });

  it('validation — delayAcknowledgmentSchema requires delayMinutes when running behind', () => {
    const result = delayAcknowledgmentSchema.safeParse({
      appointmentId: 'apt-1',
      isRunningBehind: true,
    });
    expect(result.success).toBe(false);
  });

  it('validation — delayAcknowledgmentSchema rejects delayMinutes when not running behind', () => {
    const result = delayAcknowledgmentSchema.safeParse({
      appointmentId: 'apt-1',
      isRunningBehind: false,
      delayMinutes: 10,
    });
    expect(result.success).toBe(false);
  });
});

describe('direct job scheduling contracts', () => {
  const TECH = '11111111-1111-1111-1111-111111111111';
  const baseCreate = {
    customerId: 'cust-1',
    locationId: 'loc-1',
    summary: 'Fix the sink',
  };

  it('createJobSchema accepts a job with no schedule (legacy unscheduled)', () => {
    expect(createJobSchema.safeParse(baseCreate).success).toBe(true);
  });

  it('createJobSchema accepts an inline schedule block', () => {
    const result = createJobSchema.safeParse({
      ...baseCreate,
      scheduledStart: '2026-07-01T15:00:00.000Z',
      technicianId: TECH,
      durationMin: 90,
      timezone: 'America/New_York',
    });
    expect(result.success).toBe(true);
  });

  it('createJobSchema rejects a non-ISO scheduledStart', () => {
    const result = createJobSchema.safeParse({ ...baseCreate, scheduledStart: 'tomorrow 2pm' });
    expect(result.success).toBe(false);
  });

  it('createJobSchema rejects a non-positive durationMin', () => {
    const result = createJobSchema.safeParse({ ...baseCreate, scheduledStart: '2026-07-01T15:00:00.000Z', durationMin: 0 });
    expect(result.success).toBe(false);
  });

  it('scheduleJobSchema requires scheduledStart and rejects unknown keys', () => {
    expect(scheduleJobSchema.safeParse({ scheduledStart: '2026-07-01T15:00:00.000Z' }).success).toBe(true);
    expect(scheduleJobSchema.safeParse({}).success).toBe(false);
    expect(
      scheduleJobSchema.safeParse({ scheduledStart: '2026-07-01T15:00:00.000Z', bogus: true }).success,
    ).toBe(false);
  });

  it('reassignJobSchema accepts a uuid or explicit null, rejects absent/garbage', () => {
    expect(reassignJobSchema.safeParse({ technicianId: TECH }).success).toBe(true);
    expect(reassignJobSchema.safeParse({ technicianId: null }).success).toBe(true);
    expect(reassignJobSchema.safeParse({}).success).toBe(false);
    expect(reassignJobSchema.safeParse({ technicianId: 'not-a-uuid' }).success).toBe(false);
  });

  it('unscheduleJobSchema accepts an optional reason and rejects unknown keys', () => {
    expect(unscheduleJobSchema.safeParse({}).success).toBe(true);
    expect(unscheduleJobSchema.safeParse({ reason: 'customer canceled' }).success).toBe(true);
    expect(unscheduleJobSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
