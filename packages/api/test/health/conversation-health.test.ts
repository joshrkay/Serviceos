import { createConversationHealthCheck } from '../../src/health/conversation-health';

describe('P3-011 — Conversation state and retry handling (API)', () => {
  it('happy path — health check returns ok when all subsystems healthy', async () => {
    const healthCheck = createConversationHealthCheck(async () => ({
      conversationService: true,
      transcriptionQueue: true,
      aiRunService: true,
    }));

    const result = await healthCheck.check();
    expect(result.status).toBe('ok');
  });

  it('validation — degraded status when transcription queue is slow', async () => {
    const healthCheck = createConversationHealthCheck(async () => ({
      conversationService: true,
      transcriptionQueue: false,
      aiRunService: true,
    }));

    const result = await healthCheck.check();
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('transcription');
  });

  it('happy path — down status when all subsystems fail', async () => {
    const healthCheck = createConversationHealthCheck(async () => ({
      conversationService: false,
      transcriptionQueue: false,
      aiRunService: false,
    }));

    const result = await healthCheck.check();
    expect(result.status).toBe('down');
  });

  it('validation — handles check failure gracefully', async () => {
    const healthCheck = createConversationHealthCheck(async () => {
      throw new Error('Connection refused');
    });

    const result = await healthCheck.check();
    expect(result.status).toBe('down');
    expect(result.message).toContain('Failed to check');
  });
});
