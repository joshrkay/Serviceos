/**
 * Structural subset of `@typesafe-ai/sdk`'s `TypeSafeClient.systemOne` and the
 * HTTP contract (POST /v1/systemone), so the spike runs and tests offline with
 * no SDK dependency. The real SDK client satisfies this shape.
 */
export type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; levels: string[] };

export interface SystemOneRequest {
  state: string | Record<string, unknown>;
  model: string;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneAnswer {
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface SystemOneClient {
  systemOne(req: SystemOneRequest): Promise<{ answers: Record<string, SystemOneAnswer> }>;
}

export const SPIKE_MODEL = 'jev-latest';
