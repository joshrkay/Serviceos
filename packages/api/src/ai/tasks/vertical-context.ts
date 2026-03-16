import { ContextBlock, createContextBlock } from '../context-assembly';
import { LoadedVerticalPack } from '../../verticals/vertical-loader';
import { TerminologyMap, TerminologyEntry } from '../../verticals/terminology-map';

export function buildVerticalContextBlock(loadedPack: LoadedVerticalPack): ContextBlock {
  const content = [
    `Vertical: ${loadedPack.pack.name} (${loadedPack.pack.slug})`,
    `Version: ${loadedPack.pack.version}`,
    `Description: ${loadedPack.pack.description}`,
    '',
    `Categories: ${loadedPack.taxonomy.categories.filter((c) => !c.parentId).map((c) => c.name).join(', ')}`,
    '',
    'Key terminology:',
    formatTerminologyForPrompt(loadedPack.terminology.entries.slice(0, 10)),
  ].join('\n');

  return createContextBlock('vertical_pack', loadedPack.pack.slug, content, 10);
}

export function buildTerminologyContextBlock(terminologyMap: TerminologyMap): ContextBlock {
  const content = formatTerminologyForPrompt(terminologyMap.entries);
  return createContextBlock('terminology', terminologyMap.verticalSlug, content, 8);
}

export async function assembleVerticalContext(
  tenantId: string,
  verticalSlug: string,
  loader: { loadBySlug(slug: string): Promise<LoadedVerticalPack | null> }
): Promise<ContextBlock[]> {
  const loaded = await loader.loadBySlug(verticalSlug);
  if (!loaded) return [];

  return [
    buildVerticalContextBlock(loaded),
    buildTerminologyContextBlock(loaded.terminology),
  ];
}

export function formatTerminologyForPrompt(entries: TerminologyEntry[]): string {
  return entries
    .map((e) => `- ${e.term}: ${e.definition}${e.aliases.length > 0 ? ` (also: ${e.aliases.join(', ')})` : ''}`)
    .join('\n');
}
