import { describe, expect, it } from "vitest";
import {
  getChatbotBuildPromptLabel,
  getChatbotDisplayName,
  getChatbotPromptEmptyStateBody,
  getChatbotPromptGoalPlaceholder,
} from "../chatbot-ui.js";

describe("getChatbotDisplayName", () => {
  it("maps supported chatbot hosts to friendly display names", () => {
    expect(getChatbotDisplayName("claude.ai")).toBe("Claude");
    expect(getChatbotDisplayName("chat.openai.com")).toBe("ChatGPT");
    expect(getChatbotDisplayName("chatgpt.com")).toBe("ChatGPT");
    expect(getChatbotDisplayName("gemini.google.com")).toBe("Gemini");
  });

  it("normalizes full URLs and wildcard patterns", () => {
    expect(getChatbotDisplayName("https://www.chatgpt.com/c/123")).toBe("ChatGPT");
    expect(getChatbotDisplayName("*.claude.ai")).toBe("Claude");
  });

  it("falls back cleanly for unknown chatbots", () => {
    expect(getChatbotDisplayName("perplexity.ai")).toBeNull();
    expect(getChatbotDisplayName(null)).toBeNull();
  });
});

describe("chatbot UI copy helpers", () => {
  it("builds chatbot-specific labels when a name is known", () => {
    expect(getChatbotBuildPromptLabel("Claude")).toBe("Build prompt for Claude");
    expect(getChatbotPromptGoalPlaceholder("Gemini")).toBe(
      "What do you want Gemini to do?",
    );
  });

  it("falls back to generic chatbot copy when no name is known", () => {
    expect(getChatbotBuildPromptLabel(null)).toBe("Build prompt");
    expect(getChatbotPromptGoalPlaceholder(null)).toBe(
      "What do you want the chatbot to do?",
    );
    expect(getChatbotPromptEmptyStateBody(null)).toContain("chatbot prompt");
  });
});
