import { v4 as uuidv4 } from 'uuid';

export interface PromptVersion {
  id: string;
  taskType: string;
  version: number;
  template: string;
  model: string;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
}

export interface CreatePromptVersionInput {
  taskType: string;
  template: string;
  model: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface PromptVersionRepository {
  create(version: PromptVersion): Promise<PromptVersion>;
  findById(id: string): Promise<PromptVersion | null>;
  findActive(taskType: string): Promise<PromptVersion | null>;
  findByTaskType(taskType: string): Promise<PromptVersion[]>;
  activate(id: string): Promise<PromptVersion | null>;
  deactivateAll(taskType: string): Promise<void>;
  getNextVersion(taskType: string): Promise<number>;
}

export function validatePromptVersionInput(input: CreatePromptVersionInput): string[] {
  const errors: string[] = [];
  if (!input.taskType) errors.push('taskType is required');
  if (!input.template) errors.push('template is required');
  if (!input.model) errors.push('model is required');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

export class InMemoryPromptVersionRepository implements PromptVersionRepository {
  private versions: Map<string, PromptVersion> = new Map();

  async create(version: PromptVersion): Promise<PromptVersion> {
    this.versions.set(version.id, { ...version });
    return version;
  }

  async findById(id: string): Promise<PromptVersion | null> {
    return this.versions.get(id) || null;
  }

  async findActive(taskType: string): Promise<PromptVersion | null> {
    for (const v of this.versions.values()) {
      if (v.taskType === taskType && v.isActive) return { ...v };
    }
    return null;
  }

  async findByTaskType(taskType: string): Promise<PromptVersion[]> {
    return Array.from(this.versions.values())
      .filter((v) => v.taskType === taskType)
      .sort((a, b) => b.version - a.version);
  }

  async activate(id: string): Promise<PromptVersion | null> {
    const version = this.versions.get(id);
    if (!version) return null;

    // Deactivate all for same taskType
    await this.deactivateAll(version.taskType);

    version.isActive = true;
    this.versions.set(id, version);
    return { ...version };
  }

  async deactivateAll(taskType: string): Promise<void> {
    for (const v of this.versions.values()) {
      if (v.taskType === taskType) v.isActive = false;
    }
  }

  async getNextVersion(taskType: string): Promise<number> {
    const versions = await this.findByTaskType(taskType);
    if (versions.length === 0) return 1;
    return Math.max(...versions.map((v) => v.version)) + 1;
  }
}

export async function registerPromptVersion(
  input: CreatePromptVersionInput,
  repository: PromptVersionRepository
): Promise<PromptVersion> {
  const nextVersion = await repository.getNextVersion(input.taskType);

  const version: PromptVersion = {
    id: uuidv4(),
    taskType: input.taskType,
    version: nextVersion,
    template: input.template,
    model: input.model,
    isActive: false,
    metadata: input.metadata,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };

  await repository.create(version);
  return version;
}

export async function activatePromptVersion(
  id: string,
  repository: PromptVersionRepository
): Promise<PromptVersion | null> {
  return repository.activate(id);
}
