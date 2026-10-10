import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const mockGeneratePdfPageSummary = vi.fn();
const mockRpc = vi.fn();
const mockCreateUserClient = vi.fn();
const mockResolveRequestLlm = vi.fn();
const mockResolveCacheTagForRead = vi.fn();

vi.mock("../../lib/llm.js", () => ({
  generatePdfPageSummary: mockGeneratePdfPageSummary,
}));

vi.mock("../../lib/llm-config.js", () => ({
  resolveRequestLlm: (userId: string) => mockResolveRequestLlm(userId),
  resolveCacheTagForRead: (userId: string) => mockResolveCacheTagForRead(userId),
  sendLlmConfigError: vi.fn(() => false),
}));

vi.mock("../../lib/supabase.js", () => ({
  serviceClient: {
    rpc: mockRpc,
  },
  createUserClient: mockCreateUserClient,
}));

class MockRequest extends EventEmitter {
  headers: Record<string, string>;
  body: unknown;
  method = "POST";
  url = "/generate";
  query: Record<string, string> = {};
  user = {
    id: "user_1",
    email: "user@example.com",
    tier: "standard" as const,
  };

  constructor(body: unknown) {
    super();
    this.body = body;
    this.headers = {
      authorization: "Bearer token",
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

async function invokeRouter(router: Router, body: unknown): Promise<unknown> {
  const req = new MockRequest(body);
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
  return payload;
}

function createMaybeSingleBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return builder;
}

function createInsertBuilder(result: unknown) {
  const builder = {
    insert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn().mockResolvedValue(result),
  };
  return builder;
}

describe("pdf page summaries route", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGeneratePdfPageSummary.mockReset();
    mockRpc.mockReset();
    mockCreateUserClient.mockReset();
    mockResolveRequestLlm.mockReset();
    mockResolveRequestLlm.mockResolvedValue({
      override: null,
      bypassLimits: false,
      cacheTag: null,
    });
    mockResolveCacheTagForRead.mockReset();
    mockResolveCacheTagForRead.mockResolvedValue("");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an existing summary instead of regenerating", async () => {
    const existingSummary = {
      id: "summary_1",
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "1",
      page_text_hash: "sha256:page",
      summary: "Existing page summary.",
      page_title: "Example PDF",
      created_at: "2026-04-06T00:00:00.000Z",
      updated_at: "2026-04-06T00:00:00.000Z",
    };
    const existingBuilder = createMaybeSingleBuilder({
      data: existingSummary,
      error: null,
    });
    mockCreateUserClient.mockReturnValue({
      from: vi.fn(() => existingBuilder),
    });

    const { default: router } = await import("../../routes/pdf-page-summaries.js");
    const payload = (await invokeRouter(router, {
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "1",
      page_text_hash: "sha256:page",
      text: "Page text",
      page_title: "Example PDF",
    })) as Record<string, unknown>;

    expect(payload.cached).toBe(true);
    expect(payload.summary).toEqual(existingSummary);
    expect(mockGeneratePdfPageSummary).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    // Tier default reads only its own ("") variant.
    expect(existingBuilder.eq).toHaveBeenCalledWith("model_version", "");
  });

  it("generates and saves a new page summary when none exists", async () => {
    const existingBuilder = createMaybeSingleBuilder({
      data: null,
      error: null,
    });
    const insertedSummary = {
      id: "summary_2",
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "2",
      page_text_hash: "sha256:page-2",
      summary: "Generated page summary.",
      page_title: "Example PDF",
      created_at: "2026-04-06T00:00:00.000Z",
      updated_at: "2026-04-06T00:00:00.000Z",
    };
    const insertBuilder = createInsertBuilder({
      data: insertedSummary,
      error: null,
    });
    mockCreateUserClient.mockReturnValue({
      from: vi
        .fn()
        .mockImplementationOnce(() => existingBuilder)
        .mockImplementationOnce(() => insertBuilder),
    });
    mockRpc.mockResolvedValueOnce({
      data: { allowed: true, count: 1, already_counted: false },
      error: null,
    });
    mockGeneratePdfPageSummary.mockResolvedValue("Generated page summary.");

    const { default: router } = await import("../../routes/pdf-page-summaries.js");
    const payload = (await invokeRouter(router, {
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "2",
      page_text_hash: "sha256:page-2",
      text: "Page text",
      page_title: "Example PDF",
    })) as Record<string, unknown>;

    expect(payload.cached).toBe(false);
    expect(payload.summary).toEqual(insertedSummary);
    expect(mockGeneratePdfPageSummary).toHaveBeenCalledWith(
      "Page text",
      expect.objectContaining({
        override: null,
        logContext: expect.objectContaining({
          route: "pdf-page-summary",
          contentHash: "sha256:page-2",
        }),
      }),
    );
    expect(mockRpc).toHaveBeenCalledWith("check_and_record_usage", {
      p_user_id: "user_1",
      p_url: "https://example.com/file.pdf#pdf-page-summary:sha256:doc:2",
      p_limit: 2000,
    });
    expect(existingBuilder.eq).toHaveBeenCalledWith("model_version", "");
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ model_version: "" }),
    );
  });

  it("threads the BYOK override through and skips usage counting", async () => {
    const cacheTag = "openai:gpt-5:default:abc123def456";
    const override = {
      provider: "openai",
      transport: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKeys: ["user-key"],
      model: "gpt-5",
      effort: "default",
    };
    mockResolveRequestLlm.mockResolvedValue({
      override,
      bypassLimits: true,
      cacheTag,
    });
    const existingBuilder = createMaybeSingleBuilder({
      data: null,
      error: null,
    });
    const insertedSummary = {
      id: "summary_3",
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "3",
      page_text_hash: "sha256:page-3",
      summary: "BYOK page summary.",
      page_title: "Example PDF",
      created_at: "2026-04-06T00:00:00.000Z",
      updated_at: "2026-04-06T00:00:00.000Z",
    };
    const insertBuilder = createInsertBuilder({
      data: insertedSummary,
      error: null,
    });
    mockCreateUserClient.mockReturnValue({
      from: vi
        .fn()
        .mockImplementationOnce(() => existingBuilder)
        .mockImplementationOnce(() => insertBuilder),
    });
    mockGeneratePdfPageSummary.mockResolvedValue("BYOK page summary.");

    const { default: router } = await import("../../routes/pdf-page-summaries.js");
    const payload = (await invokeRouter(router, {
      url: "https://example.com/file.pdf",
      document_hash: "sha256:doc",
      page_no: "3",
      page_text_hash: "sha256:page-3",
      text: "Page text",
      page_title: "Example PDF",
    })) as Record<string, unknown>;

    expect(payload.cached).toBe(false);
    expect(payload.summary).toEqual(insertedSummary);
    expect(mockGeneratePdfPageSummary).toHaveBeenCalledWith(
      "Page text",
      expect.objectContaining({ override }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      "check_and_record_usage",
      expect.anything(),
    );
    expect(existingBuilder.eq).toHaveBeenCalledWith("model_version", cacheTag);
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ model_version: cacheTag }),
    );
  });
});
