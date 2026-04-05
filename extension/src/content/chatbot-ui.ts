function normalizeHost(value: string | null | undefined): string {
  if (!value) return "";

  let normalized = value.trim().toLowerCase();
  if (!normalized) return "";

  if (normalized.includes("://")) {
    try {
      normalized = new URL(normalized).hostname.toLowerCase();
    } catch {
      // Fall back to string-based normalization below.
    }
  }

  normalized = normalized.replace(/^\*\./, "");
  normalized = normalized.replace(/^www\./, "");
  normalized = normalized.split("/")[0] ?? normalized;
  return normalized;
}

const CHATBOT_DISPLAY_NAMES: Record<string, string> = {
  "chat.openai.com": "ChatGPT",
  "chatgpt.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
};

export function getChatbotDisplayName(
  hostnameOrPattern: string | null | undefined,
): string | null {
  const normalized = normalizeHost(hostnameOrPattern);
  if (!normalized) return null;

  return CHATBOT_DISPLAY_NAMES[normalized] ?? null;
}

export function getChatbotBuildPromptLabel(
  displayName: string | null | undefined,
): string {
  return displayName ? `Build prompt for ${displayName}` : "Build prompt";
}

export function getChatbotPromptGoalPlaceholder(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `What do you want ${displayName} to do?`
    : "What do you want the chatbot to do?";
}

export function getChatbotPromptGoalHelper(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Oddity builds a complete prompt for ${displayName} from the page, your compiled notes and replies, and your prompt goal.`
    : "Oddity builds a complete prompt from the page, your compiled notes and replies, and your prompt goal.";
}

export function getChatbotPromptLoadingLabel(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Building prompt for ${displayName}...`
    : "Building prompt...";
}

export function getChatbotPromptErrorText(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Failed to build prompt for ${displayName}. Please try again.`
    : "Failed to build prompt. Please try again.";
}

export function getChatbotPromptEmptyStateTitle(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Ready-to-send prompt for ${displayName}`
    : "Ready-to-send prompt";
}

export function getChatbotPromptEmptyStateBody(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Oddity will compile the page, your notes and replies, and your prompt goal into a prompt for ${displayName}.`
    : "Oddity will compile the page, your notes and replies, and your prompt goal into a chatbot prompt.";
}

export function getChatbotOnboardingTitle(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Build a Prompt for ${displayName}`
    : "Build a Chatbot Prompt";
}

export function getChatbotOnboardingBody(
  displayName: string | null | undefined,
): string {
  return displayName
    ? `Your reactions and replies compile into a complete prompt for ${displayName}.`
    : "Your reactions and replies compile into a complete prompt for a chatbot.";
}
