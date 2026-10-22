/**
 * D-044 / #1769 — drafts the "about" copy for the hosted tenant site from
 * tenant settings (business name, trade, services, service area, brand voice),
 * through the LLM gateway.
 *
 * Draft only. The caller wraps the text in an `update_tenant_site_about`
 * proposal; nothing reaches the public page until the owner approves it
 * (and may edit it first). The prompt gives the model only facts the owner
 * already entered, and forbids inventing the rest — years in business,
 * licences, awards, guarantees, prices — because this text is published under
 * the business's name.
 */
import { LLMGateway } from '../gateway/gateway';
import type { BrandVoiceSettings } from '../../settings/settings';
import { resolveRegister } from '../brand-voice/prompts';
import { TENANT_SITE_ABOUT_MAX_LENGTH } from '../../proposals/contracts/tenant-site-about';

export interface TenantSiteAboutInput {
  tenantId: string;
  businessName: string;
  /** Display names of the active service packs (e.g. "Plumbing", "HVAC"). */
  services: string[];
  serviceArea?: string | null;
  brandVoice?: BrandVoiceSettings | null;
}

export interface TenantSiteAboutDraft {
  aboutText: string;
}

/** Aim well under the contract's cap so an edit has room to grow. */
const TARGET_WORDS = 90;

export function buildTenantSiteAboutPrompt(input: TenantSiteAboutInput): { system: string; user: string } {
  const bv = input.brandVoice ?? {};
  const pronoun = bv.pronoun === 'i' ? 'I' : 'we';
  const tone =
    resolveRegister(bv) === 'formal'
      ? 'professional and polished'
      : 'warm, friendly, and plain-spoken';
  const vibe =
    bv.vibe_words && bv.vibe_words.length > 0
      ? ` Lean into this character: ${bv.vibe_words.join(', ')}.`
      : '';

  const system = [
    `You write the "About us" section of a one-page website for a local home-services business.`,
    `Write in the first person as the business, using "${pronoun}". Tone: ${tone}.${vibe}`,
    `Rules:`,
    `- Use ONLY the facts given. Do not invent years in business, licences, certifications, awards, guarantees, prices, owner names, team size, or reviews.`,
    `- Mention the services and the area served when given, naturally, not as a list dump.`,
    `- End with a short invitation to call or request a quote. Do not include a phone number or address.`,
    `- Plain text only: no markdown, no headings, no bullet points, no emojis, no quotation marks around the text.`,
    `- One or two short paragraphs, about ${TARGET_WORDS} words in total.`,
    `Return ONLY the about text.`,
  ].join('\n');

  const facts = [
    `Business name: ${input.businessName}`,
    input.services.length ? `Services: ${input.services.join(', ')}` : 'Services: not specified',
    input.serviceArea?.trim() ? `Area served: ${input.serviceArea.trim()}` : 'Area served: not specified',
  ];
  const user = `Facts about the business:\n${facts.join('\n')}\n\nWrite the About us text.`;
  return { system, user };
}

/** Cleans a model reply into plain text within the contract's cap. */
export function cleanTenantSiteAboutText(raw: string): string {
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/^["“”']+|["“”']+$/g, '')
    // Models sometimes add markdown emphasis/headings despite the instruction.
    .replace(/^#+\s*(about us)?\s*$/gim, '')
    .replace(/\*\*|__/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > TENANT_SITE_ABOUT_MAX_LENGTH) {
    // Cut at the last sentence end that fits, else hard cut at a word.
    const cut = text.slice(0, TENANT_SITE_ABOUT_MAX_LENGTH);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = sentenceEnd > TENANT_SITE_ABOUT_MAX_LENGTH * 0.5 ? cut.slice(0, sentenceEnd + 1) : cut.slice(0, cut.lastIndexOf(' ')).trim();
  }
  return text;
}

export class TenantSiteAboutTask {
  readonly taskType = 'tenant_site_about' as const;

  constructor(private readonly gateway: LLMGateway) {}

  async draft(input: TenantSiteAboutInput): Promise<TenantSiteAboutDraft> {
    const { system, user } = buildTenantSiteAboutPrompt(input);
    const response = await this.gateway.complete({
      taskType: this.taskType,
      tenantId: input.tenantId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.6,
      responseFormat: 'text',
    });
    const aboutText = cleanTenantSiteAboutText(response.content);
    if (!aboutText) {
      throw new Error('The assistant returned an empty draft');
    }
    return { aboutText };
  }
}
