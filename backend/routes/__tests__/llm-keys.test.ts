import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const mockFrom = vi.fn();

vi.mock("../../lib/supabase.js", () => ({
  serviceClient: { from: mockFrom },
}));

const TEST_KEY = "0123456789abcdef".repeat(4);

class MockRequest extends EventEmitter {
  headers: Record<string, string>;
  body: unknown;
  method: string;
  url: string;
  query: Record<string, string> = {};
  user = {
    id: "user_1",
    email: "user@example.com",
    tier: "free" as const,
  };

  constructor(method: string, url: string, body: unknown) {
    super();
    this.method = method;
    this.url = url;
    this.body = body;
    this.headers = {
      authorization: "Bearer [REDACTED]",
      "content-type": "application/json",
    };
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  payload: unknown;
  private resolvePayload?: (value: unknown) => void;

  awaitPayload(): Promise<unknown> {
    return new Promise((resolve) => {
      this.resolvePayload = resolve;
    });
  }

  setHeader(): void {}

  flushHeaders(): void {}

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    this.writableEnded = true;
    this.resolvePayload?.(payload);
    return this;
  }

  end(): this {
    this.writableEnded = true;
    this.resolvePayload?.(this.payload);
    return this;
  }
}

async function invokeRouter(
  router: Router,
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const req = new MockRequest(method, url, body);
  const res = new MockResponse();
  const payloadPromise = res.awaitPayload();
  let nextError: unknown;
  const directRouter = router as Router & {
    handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => void;
  };

  directRouter.handle(req, res, (error?: unknown) => {
    nextError = error;
    if (!res.writableEnded) {
      res.end();
    }
  });

  const payload = await payloadPromise;
  if (nextError) throw nextError;
  return { status: res.statusCode, payload };
}

function createKeysTableStub(config: {
  fetchResult: unknown;
  upsertResult: unknown;
  deleteResult?: unknown;
  onUpsert?: (row: unknown) => void;
}) {
  const fetchBuilder = {
    select: vi.fn(() => fetchBuilder),
    eq: vi.fn(() => fetchBuilder),
    single: vi.fn(async () => config.fetchResult),
    // Real Supabase builders are thenable: awaiting the chain executes it.
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(config.fetchResult).then(resolve),
  };
  const upsertBuilder = {
    select: vi.fn(() => upsertBuilder),
    single: vi.fn(async () => config.upsertResult),
  };
  const deleteBuilder = {
    eq: vi.fn(() => deleteBuilder),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(config.deleteResult ?? { error: null }).then(resolve),
  };
  return {
    select: vi.fn(() => fetchBuilder),
    eq: vi.fn(() => fetchBuilder),
    upsert: vi.fn((row: unknown) => {
      config.onUpsert?.(row);
      return upsertBuilder;
    }),
    delete: vi.fn(() => deleteBuilder),
  };
}

function createProfilesTableStub(
  queryResult: unknown,
  onUpdate?: (patch: unknown) => void,
) {
  const fetchBuilder = {
    select: vi.fn(() => fetchBuilder),
    eq: vi.fn(() => fetchBuilder),
    single: vi.fn(async () => queryResult),
  };
  return {
    select: vi.fn(() => fetchBuilder),
    update: vi.fn((patch: unknown) => {
      onUpdate?.(patch);
      return { eq: vi.fn(async () => ({ error: null })) };
    }),
  };
}

describe("llm-keys routes", () => {
  let savedCrypto: string | undefined;
  let savedOpenRouter: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
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

  it("lists statuses for every provider with the active selection", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: {
            data: [
              {
                provider: "openai",
                key_hint: "****1234",
                model: "gpt-5-mini",
                base_url: "",
                reasoning_effort: "low",
                updated_at: "2026-10-09T00:00:00Z",
              },
            ],
            error: null,
          },
          upsertResult: { data: null, error: null },
        });
      }
      return createProfilesTableStub({
        data: { preferences: { llm_provider: "openai" } },
        error: null,
      });
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");
    const { status, payload } = await invokeRouter(
      llmKeysRouter,
      "GET",
      "/",
      {},
    );

    expect(status).toBe(200);
    const body = payload as {
      active_provider: string | null;
      keys: Array<{ provider: string; configured: boolean; key_hint: string | null }>;
    };
    expect(body.active_provider).toBe("openai");
    expect(body.keys).toHaveLength(6);
    const openai = body.keys.find((k) => k.provider === "openai");
    expect(openai?.configured).toBe(true);
    expect(openai?.key_hint).toBe("****1234");
    const anthropic = body.keys.find((k) => k.provider === "anthropic");
    expect(anthropic?.configured).toBe(false);
    const free = body.keys.find((k) => k.provider === "oddity-free");
    expect(free?.configured).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("server-key");
  });

  it("returns 503 when the keys table is missing", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: {
            data: null,
            error: { code: "42P01", message: "missing" },
          },
          upsertResult: { data: null, error: null },
        });
      }
      return createProfilesTableStub({ data: null, error: null });
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");
    const { status } = await invokeRouter(llmKeysRouter, "GET", "/", {});
    expect(status).toBe(503);
  });

  it("saves a new key encrypted and returns only a hint", async () => {
    let stored: Record<string, unknown> = {};
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: { data: null, error: { code: "PGRST116" } },
          upsertResult: {
            data: {
              provider: "anthropic",
              key_hint: "****5678",
              model: "claude-sonnet-4.5",
              base_url: "",
              reasoning_effort: "medium",
              updated_at: "2026-10-09T00:00:00Z",
            },
            error: null,
          },
          onUpsert: (row) => {
            stored = row as Record<string, unknown>;
          },
        });
      }
      return createProfilesTableStub({ data: null, error: null });
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");
    const { status, payload } = await invokeRouter(
      llmKeysRouter,
      "PUT",
      "/anthropic",
      {
        api_key: "sk-ant-12345678",
        model: "claude-sonnet-4.5",
        reasoning_effort: "medium",
      },
    );

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      provider: "anthropic",
      configured: true,
      key_hint: "****5678",
    });
    expect(JSON.stringify(payload)).not.toContain("sk-ant-12345678");
    expect(stored.key_encrypted).toBeDefined();
    expect(String(stored.key_encrypted)).not.toContain("sk-ant-12345678");

    const { decryptByokKey } = await import("../../lib/byok-crypto.js");
    expect(decryptByokKey(String(stored.key_encrypted))).toBe(
      "sk-ant-12345678",
    );
  });

  it("updates settings without re-entering the key", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: {
            data: {
              key_encrypted: "v1.existing.cipher.text",
              key_hint: "****0000",
              model: "gpt-5-mini",
              base_url: "",
              reasoning_effort: "default",
            },
            error: null,
          },
          upsertResult: {
            data: {
              provider: "openai",
              key_hint: "****0000",
              model: "gpt-5",
              base_url: "",
              reasoning_effort: "default",
              updated_at: "2026-10-09T00:00:00Z",
            },
            error: null,
          },
        });
      }
      return createProfilesTableStub({ data: null, error: null });
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");
    const { status, payload } = await invokeRouter(llmKeysRouter, "PUT", "/openai", {
      model: "gpt-5",
    });

    expect(status).toBe(200);
    expect(payload).toMatchObject({ model: "gpt-5", key_hint: "****0000" });
  });

  it("rejects invalid providers, missing keys, and non-https URLs", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: { data: null, error: { code: "PGRST116" } },
          upsertResult: { data: null, error: null },
        });
      }
      return createProfilesTableStub({ data: null, error: null });
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");

    const oddityFree = await invokeRouter(
      llmKeysRouter,
      "PUT",
      "/oddity-free",
      { api_key: "x" },
    );
    expect(oddityFree.status).toBe(400);

    const unknown = await invokeRouter(llmKeysRouter, "PUT", "/nope", {
      api_key: "x",
    });
    expect(unknown.status).toBe(400);

    const noKey = await invokeRouter(llmKeysRouter, "PUT", "/openai", {
      model: "gpt-5",
    });
    expect(noKey.status).toBe(400);

    const httpUrl = await invokeRouter(llmKeysRouter, "PUT", "/openai", {
      api_key: "sk-x",
      base_url: "http://proxy.local/v1",
    });
    expect(httpUrl.status).toBe(400);
  });

  it("deletes a key and clears it when active", async () => {
    let clearedPatch: unknown = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === "user_llm_keys") {
        return createKeysTableStub({
          fetchResult: { data: null, error: null },
          upsertResult: { data: null, error: null },
        });
      }
      return createProfilesTableStub(
        { data: { preferences: { llm_provider: "gemini" } }, error: null },
        (patch) => {
          clearedPatch = patch;
        },
      );
    });

    const { default: llmKeysRouter } = await import("../user/llm-keys.js");
    const { status, payload } = await invokeRouter(
      llmKeysRouter,
      "DELETE",
      "/gemini",
      {},
    );

    expect(status).toBe(200);
    expect(payload).toEqual({ deleted: true });
    expect(clearedPatch).toMatchObject({
      preferences: { llm_provider: null },
    });
  });
});
