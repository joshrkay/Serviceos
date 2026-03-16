import { v4 as uuidv4 } from 'uuid';

export interface TerminologyEntry {
  term: string;
  aliases: string[];
  definition: string;
  category?: string;
}

export interface TerminologyMap {
  id: string;
  verticalSlug: string;
  version: string;
  entries: TerminologyEntry[];
  createdAt: Date;
}

export interface CreateTerminologyMapInput {
  verticalSlug: string;
  version: string;
  entries: TerminologyEntry[];
}

export interface TerminologyMapRepository {
  create(map: TerminologyMap): Promise<TerminologyMap>;
  findById(id: string): Promise<TerminologyMap | null>;
  findByVertical(verticalSlug: string): Promise<TerminologyMap[]>;
  findLatestByVertical(verticalSlug: string): Promise<TerminologyMap | null>;
}

export function validateTerminologyMapInput(input: CreateTerminologyMapInput): string[] {
  const errors: string[] = [];
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.version) errors.push('version is required');
  if (!Array.isArray(input.entries)) errors.push('entries must be an array');
  return errors;
}

export function createTerminologyMap(input: CreateTerminologyMapInput): TerminologyMap {
  return {
    id: uuidv4(),
    verticalSlug: input.verticalSlug,
    version: input.version,
    entries: input.entries,
    createdAt: new Date(),
  };
}

export function lookupTerm(map: TerminologyMap, term: string): TerminologyEntry | null {
  const lower = term.toLowerCase();
  for (const entry of map.entries) {
    if (entry.term.toLowerCase() === lower) return entry;
    if (entry.aliases.some((a) => a.toLowerCase() === lower)) return entry;
  }
  return null;
}

export class InMemoryTerminologyMapRepository implements TerminologyMapRepository {
  private maps: Map<string, TerminologyMap> = new Map();

  async create(map: TerminologyMap): Promise<TerminologyMap> {
    this.maps.set(map.id, { ...map });
    return { ...map };
  }

  async findById(id: string): Promise<TerminologyMap | null> {
    const map = this.maps.get(id);
    return map ? { ...map } : null;
  }

  async findByVertical(verticalSlug: string): Promise<TerminologyMap[]> {
    return Array.from(this.maps.values())
      .filter((m) => m.verticalSlug === verticalSlug)
      .map((m) => ({ ...m }));
  }

  async findLatestByVertical(verticalSlug: string): Promise<TerminologyMap | null> {
    const maps = Array.from(this.maps.values())
      .filter((m) => m.verticalSlug === verticalSlug)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return maps.length > 0 ? { ...maps[0] } : null;
  }
}
