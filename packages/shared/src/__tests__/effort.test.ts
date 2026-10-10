import { describe, expect, it } from "vitest";
import {
  isOpenAiReasoningModel,
  LLM_PROVIDER_META,
  modelSupportsEffort,
} from "../constants.js";

describe("isOpenAiReasoningModel", () => {
  it.each(["o1", "o3-mini", "gpt-5", "gpt-5-mini", "  gpt-5-chat  "])(
    "accepts %s",
    (model) => {
      expect(isOpenAiReasoningModel(model)).toBe(true);
    },
  );

  it.each(["gpt-4o", "gpt-4.1", "gpt-4o-mini", "", "openai/gpt-5"])(
    "rejects %s",
    (model) => {
      expect(isOpenAiReasoningModel(model)).toBe(false);
    },
  );
});

describe("modelSupportsEffort", () => {
  it("follows the provider flag for non-OpenAI providers", () => {
    expect(modelSupportsEffort("openrouter", "anything")).toBe(true);
    expect(modelSupportsEffort("anthropic", "anything")).toBe(true);
    expect(modelSupportsEffort("gemini", "anything")).toBe(false);
    expect(modelSupportsEffort("muse", "anything")).toBe(false);
  });

  it("gates OpenAI on the model", () => {
    expect(modelSupportsEffort("openai", "gpt-5-mini")).toBe(true);
    expect(modelSupportsEffort("openai", "o3")).toBe(true);
    expect(modelSupportsEffort("openai", "gpt-4o")).toBe(false);
    expect(modelSupportsEffort("openai", "")).toBe(false);
  });

  it("treats each provider placeholder as its effective default", () => {
    // An empty model field falls back to the placeholder server-side, so the
    // placeholder itself must keep the control enabled where supported.
    for (const provider of ["openrouter", "openai", "anthropic"] as const) {
      expect(
        modelSupportsEffort(provider, LLM_PROVIDER_META[provider].modelPlaceholder),
      ).toBe(true);
    }
  });
});
