/// <reference types="vite/client" />

interface PendoTrackAgentMetadata {
  agentId: string;
  conversationId: string;
  messageId: string;
  content: string;
  modelUsed?: string;
  suggestedPrompt?: boolean;
  toolsUsed?: string[];
  fileUploaded?: boolean;
}

interface Pendo {
  trackAgent(eventType: 'prompt' | 'agent_response' | 'user_reaction', metadata: PendoTrackAgentMetadata): void;
}

declare var pendo: Pendo | undefined;
