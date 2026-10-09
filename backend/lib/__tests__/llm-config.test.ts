import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();

vi.mock("../supabase.js", () => ({
  serviceClient: { from: mockFrom },
}));

const TEST_KEY = "0123456789abcdef".repeat(4);

function queryStub(result: unknown) {
  const stub = {
    select: () => stub,
    eq: () => stub,
    single: async () => result,
  };
  return stub;
}

describe("resolveLlmForRequest", () => {
  let savedCrypto: string | undefined;
  let savedOpenRouter: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    savedCrypto = process.env.BYOK_ENCRYPTION_KEY;
    savedOpenRouter = process.env.OPENROUTER_API_KEY;
    process.env.BYOK_ENCRYPTION_KEY = TEST_KEY;
    process.env.OPENROUTER_API_KEY = "server-key";
    delete process.env.OPENROUTER_API_KEY_BACKUP1;
    delete process.env.OPENROUTER_API_KEY_BACKUP2;
  });

  afterEach(() => {
    if (savedCrypto === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
    else process.env.BYOK_ENCRYPTION_KEY = savedCrypto;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouter;
    vi.clearAllMocks();
  });

  it("returns the tier default when no provider is selected", async () => {
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: {},
    });
    expect(resolved.override).toBeNull();
    expect(resolved.bypassLimits).toBe(false);
    expect(resolved.cacheTag).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("resolves Oddity Free to the server key and free model with no caps", async () => {
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "oddity-free" },
    });
    expect(resolved.override).toMatchObject({
      provider: "oddity-free",
      transport: "openai-chat",
      apiKeys: ["server-key"],
    });
    expect(resolved.override?.model).toContain(":free");
    expect(resolved.bypassLimits).toBe(true);
    expect(resolved.cacheTag).toMatch(/^oddity-free:/);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("fails Oddity Free when the server has no OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "oddity-free" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(503);
  });

  it("resolves a BYOK Anthropic key with decrypted credentials", async () => {
    const { encryptByokKey } = await import("../byok-crypto.js");
    mockFrom.mockReturnValue(
      queryStub({
        data: {
          key_encrypted: encryptByokKey("sk-ant-user-key"),
          model: "claude-sonnet-4.5",
          base_url: "",
          reasoning_effort: "medium",
        },
        error: null,
      }),
    );
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "anthropic" },
    });
    expect(resolved.override).toMatchObject({
      provider: "anthropic",
      transport: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKeys: ["sk-ant-user-key"],
      model: "claude-sonnet-4.5",
      effort: "medium",
    });
    expect(resolved.bypassLimits).toBe(true);
    expect(resolved.cacheTag).toBe("anthropic:claude-sonnet-4.5");
  });

  it("honors a custom base URL for BYOK providers", async () => {
    const { encryptByokKey } = await import("../byok-crypto.js");
    mockFrom.mockReturnValue(
      queryStub({
        data: {
          key_encrypted: encryptByokKey("proxy-key"),
          model: "gpt-5-mini",
          base_url: "https://proxy.example.com/v1",
          reasoning_effort: "default",
        },
        error: null,
      }),
    );
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    });
    expect(resolved.override?.baseUrl).toBe("https://proxy.example.com/v1");
    expect(resolved.override?.transport).toBe("openai-chat");
  });

  it("rejects a selected provider with no saved key", async () => {
    mockFrom.mockReturnValue(
      queryStub({ data: null, error: { code: "PGRST116" } }),
    );
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(400);
  });

  it("rejects an unknown provider", async () => {
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "nope" as never },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(400);
  });

  it("returns 503 when the keys table is missing", async () => {
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    for (const error of [
      {
        code: "42P01",
        message: 'relation "user_llm_keys" does not exist',
      },
      {
        code: "PGRST205",
        message:
          "Could not find the table 'public.user_llm_keys' in the schema cache",
      },
    ]) {
      mockFrom.mockReturnValue(queryStub({ data: null, error }));
      const err = await resolveLlmForRequest({
        userId: "user_1",
        preferences: { llm_provider: "gemini" },
      }).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(LlmConfigError);
      expect((err as { status: number }).status).toBe(503);
    }
  });
});
