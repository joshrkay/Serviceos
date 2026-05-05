export const VOICE_PROMPTS = {
  TECHNICAL_DIFFICULTIES:
    "We're experiencing technical difficulties. Please try again later.",
  CALLBACK_UNAVAILABLE_TEMPLATE:
    "I'm sorry, no one is available right now. {{business}} will call you back as soon as possible. Thank you for calling.",
  TAP_TO_CONFIRM_ON_SCREEN: 'Tap to confirm on screen.',
} as const;

export function renderCallbackUnavailablePrompt(businessName: string): string {
  return VOICE_PROMPTS.CALLBACK_UNAVAILABLE_TEMPLATE.replace('{{business}}', businessName);
}
