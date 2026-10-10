import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const mockAssertSafeLlmEndpoint = vi.fn(
  async (_url: string): Promise<void> => {},
);

vi.mock("../supabase.js", () => ({
  serviceClient: { from: mockFrom },
}));

vi.mock("../ssrf.js", () => ({
  assertSafeLlmEndpoint: (url: string) => mockAssertSafeLlmEndpoint(url),
}));

const TEST_KEY = "0123456789abcdef".repeat(4);

type RecordedQuery = {
  table: string;
  selectArgs: unknown[];
  eqArgs: Array<[unknown, unknown]>;
};

const recordedQueries: RecordedQuery[] = [];

function queryStub(result: unknown) {
  const recorded: RecordedQuery = { table: "", selectArgs: [], eqArgs: [] };
  recordedQueries.push(recorded);
  const stub = {
    select: (...args: unknown[]) => {
      recorded.selectArgs.push(args);
      return stub;
    },
    eq: (column: unknown, value: unknown) => {
      recorded.eqArgs.push([column, value]);
      return stub;
    },
    single: async () => result,
  };
  return {
    stub,
    // mockImplementation wrapper so the table name is recorded too.
    forTable: (table: string) => {
      recorded.table = table;
      return stub;
    },
  };
}

/** Install a canned query result; returns the recorder for assertions. */
function stubQuery(result: unknown): RecordedQuery {
  const { forTable } = queryStub(result);
  mockFrom.mockImplementation((table: string) => forTable(table));
  return recordedQueries[recordedQueries.length - 1]!;
}

describe("resolveLlmForRequest", () => {
  let savedCrypto: string | undefined;
  let savedOpenRouter: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    mockAssertSafeLlmEndpoint.mockReset();
    mockAssertSafeLlmEndpoint.mockResolvedValue(undefined);
    recordedQueries.length = 0;
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
    const query = stubQuery({
      data: {
        key_encrypted: encryptByokKey("test-llm-key"),
        model: "claude-sonnet-4-5",
        base_url: "",
        reasoning_effort: "medium",
      },
      error: null,
    });
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "anthropic" },
    });
    expect(resolved.override).toMatchObject({
      provider: "anthropic",
      transport: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKeys: ["test-llm-key"],
      model: "claude-sonnet-4-5",
      effort: "medium",
    });
    expect(resolved.bypassLimits).toBe(true);
    expect(resolved.cacheTag).toMatch(/^anthropic:claude-sonnet-4-5:medium:/);
    // The key lookup must stay scoped to this user's row.
    expect(query.table).toBe("user_llm_keys");
    expect(query.eqArgs).toContainEqual(["user_id", "user_1"]);
    expect(query.eqArgs).toContainEqual(["provider", "anthropic"]);
    expect(mockAssertSafeLlmEndpoint).not.toHaveBeenCalled();
  });

  it("honors a custom base URL for BYOK providers", async () => {
    const { encryptByokKey } = await import("../byok-crypto.js");
    stubQuery({
      data: {
        key_encrypted: encryptByokKey("proxy-key"),
        model: "gpt-5-mini",
        base_url: "https://proxy.example.com/v1",
        reasoning_effort: "default",
      },
      error: null,
    });
    const { resolveLlmForRequest } = await import("../llm-config.js");
    const resolved = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    });
    expect(resolved.override?.baseUrl).toBe("https://proxy.example.com/v1");
    expect(resolved.override?.transport).toBe("openai-chat");
    expect(mockAssertSafeLlmEndpoint).toHaveBeenCalledWith(
      "https://proxy.example.com/v1",
    );
  });

  it("rejects a saved base URL that fails safety validation", async () => {
    const { encryptByokKey } = await import("../byok-crypto.js");
    stubQuery({
      data: {
        key_encrypted: encryptByokKey("proxy-key"),
        model: "gpt-5-mini",
        base_url: "https://proxy.example.com/v1",
        reasoning_effort: "default",
      },
      error: null,
    });
    mockAssertSafeLlmEndpoint.mockRejectedValueOnce(
      new Error("Base URL must point to a public address"),
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
    expect((err as Error).message).toContain("base URL");
  });

  it("rejects a selected provider with no saved key", async () => {
    stubQuery({ data: null, error: { code: "PGRST116" } });
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

  it("returns 503 when the key lookup fails for other reasons", async () => {
    stubQuery({ data: null, error: { code: "XX000", message: "boom" } });
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(503);
  });

  it("returns 503 when crypto is unconfigured but a key row exists", async () => {
    const { encryptByokKey } = await import("../byok-crypto.js");
    const ciphertext = encryptByokKey("test-llm-key");
    delete process.env.BYOK_ENCRYPTION_KEY;
    stubQuery({
      data: {
        key_encrypted: ciphertext,
        model: "",
        base_url: "",
        reasoning_effort: "default",
      },
      error: null,
    });
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(503);
  });

  it("returns 503 when the stored key cannot be decrypted", async () => {
    stubQuery({
      data: {
        key_encrypted: "v1.tampered.payload.here",
        model: "",
        base_url: "",
        reasoning_effort: "default",
      },
      error: null,
    });
    const { resolveLlmForRequest, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveLlmForRequest({
      userId: "user_1",
      preferences: { llm_provider: "openai" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(503);
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
      stubQuery({ data: null, error });
      const err = await resolveLlmForRequest({
        userId: "user_1",
        preferences: { llm_provider: "gemini" },
      }).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(LlmConfigError);
      expect((err as { status: number }).status).toBe(503);
    }
  });
});

describe("resolveRequestLlm", () => {
  let savedCrypto: string | undefined;
  let savedOpenRouter: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    recordedQueries.length = 0;
    savedCrypto = process.env.BYOK_ENCRYPTION_KEY;
    savedOpenRouter = process.env.OPENROUTER_API_KEY;
    process.env.BYOK_ENCRYPTION_KEY = TEST_KEY;
    process.env.OPENROUTER_API_KEY = "server-key";
  });

  afterEach(() => {
    if (savedCrypto === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
    else process.env.BYOK_ENCRYPTION_KEY = savedCrypto;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouter;
    vi.clearAllMocks();
  });

  it("treats a missing profile as the tier default", async () => {
    stubQuery({ data: null, error: { code: "PGRST116" } });
    const { resolveRequestLlm } = await import("../llm-config.js");
    const resolved = await resolveRequestLlm("user_1");
    expect(resolved.override).toBeNull();
    expect(resolved.bypassLimits).toBe(false);
  });

  it("fails closed when the profile read errors", async () => {
    stubQuery({ data: null, error: { code: "XX000", message: "boom" } });
    const { resolveRequestLlm, LlmConfigError } = await import(
      "../llm-config.js"
    );
    const err = await resolveRequestLlm("user_1").catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(LlmConfigError);
    expect((err as { status: number }).status).toBe(503);
  });
});

describe("buildLlmCacheTag", () => {
  it("covers every setting that affects generation", async () => {
    const { buildLlmCacheTag } = await import("../llm-config.js");
    const base = {
      provider: "openai" as const,
      model: "gpt-5",
      effort: "low" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const tag = buildLlmCacheTag(base);
    expect(tag).toMatch(/^openai:gpt-5:low:[0-9a-f]{12}$/);
    expect(buildLlmCacheTag({ ...base, model: "gpt-5-mini" })).not.toBe(tag);
    expect(buildLlmCacheTag({ ...base, effort: "high" })).not.toBe(tag);
    expect(
      buildLlmCacheTag({ ...base, baseUrl: "https://proxy.example.com/v1" }),
    ).not.toBe(tag);
    expect(buildLlmCacheTag({ ...base })).toBe(tag);
  });
});
