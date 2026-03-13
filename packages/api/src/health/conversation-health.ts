import { HealthCheck } from './health';

export interface ConversationSubsystemStatus {
  conversationService: boolean;
  transcriptionQueue: boolean;
  aiRunService: boolean;
}

export function createConversationHealthCheck(
  checkSubsystems: () => Promise<ConversationSubsystemStatus>
): HealthCheck {
  return {
    name: 'conversation',
    async check() {
      try {
        const status = await checkSubsystems();

        if (!status.conversationService || !status.transcriptionQueue || !status.aiRunService) {
          const downServices: string[] = [];
          if (!status.conversationService) downServices.push('conversation');
          if (!status.transcriptionQueue) downServices.push('transcription');
          if (!status.aiRunService) downServices.push('ai-run');

          const allDown = !status.conversationService && !status.transcriptionQueue && !status.aiRunService;
          return {
            status: allDown ? 'down' : 'degraded',
            message: `Unhealthy subsystems: ${downServices.join(', ')}`,
          };
        }

        return { status: 'ok' };
      } catch (err) {
        return {
          status: 'down',
          message: 'Failed to check conversation subsystem health',
        };
      }
    },
  };
}
