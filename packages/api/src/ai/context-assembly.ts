export interface ContextBlock {
  type: string;
  source: string;
  content: string;
  priority: number;
  metadata?: Record<string, unknown>;
}

export interface AssembledContext {
  blocks: ContextBlock[];
  totalTokenEstimate: number;
  assembledAt: Date;
}

export interface ContextAssembler {
  assemble(tenantId: string, taskType: string, inputs: Record<string, unknown>): Promise<AssembledContext>;
}

export function createContextBlock(type: string, source: string, content: string, priority: number): ContextBlock {
  return { type, source, content, priority };
}

export function assembleContext(blocks: ContextBlock[]): AssembledContext {
  const sorted = [...blocks].sort((a, b) => b.priority - a.priority);
  const totalTokenEstimate = sorted.reduce((sum, b) => sum + estimateTokens(b.content), 0);
  return {
    blocks: sorted,
    totalTokenEstimate,
    assembledAt: new Date(),
  };
}

export function estimateTokens(text: string): number {
  // Rough approximation: ~4 characters per token
  return Math.ceil(text.length / 4);
}
