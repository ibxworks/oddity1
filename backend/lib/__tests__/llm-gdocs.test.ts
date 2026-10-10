import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFetch = ReturnType<typeof vi.fn>;

let mockFetch: MockFetch;
let fetchQueue: Array<() => unknown>;

function sseData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function streamResponse(chunks: string[]): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body: ReadableStream<Uint8Array>;
} {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

function jsonResponse(content: string): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  };
}

function errorResponse(
  status: number,
  message: string,
): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
} {
  return {
    ok: false,
    status,
    text: async () => message,
  };
}

type FetchBody = {
  model?: string;
  temperature?: unknown;
  max_tokens?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
};

function requestBody(callIndex: number): FetchBody {
  const init = mockFetch.mock.calls[callIndex]?.[1] as
    | { body?: string }
    | undefined;
  return JSON.parse(init?.body ?? "{}") as FetchBody;
}

function authHeader(callIndex: number): string | undefined {
  const init = mockFetch.mock.calls[callIndex]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.Authorization;
}

function anthropicSse(text: string): string {
  return (
    `event: message_start\ndata: {"type":"message_start"}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    })}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`
  );
}

describe("GDocs generation", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchQueue = [];
    mockFetch = vi.fn(async () => {
      const factory = fetchQueue.shift();
      if (!factory) {
        throw new Error("No fetch response left in queue");
      }
      return factory();
    });
    vi.stubGlobal("fetch", mockFetch);
    process.env.NODE_ENV = "test";
    process.env.OPENROUTER_API_KEY = "key1";
    delete process.env.OPENROUTER_API_KEY_BACKUP1;
    delete process.env.OPENROUTER_API_KEY_BACKUP2;
    // Attempt/retry counts affect call-count assertions — pin to defaults.
    delete process.env.OPENROUTER_ATTEMPTS_PER_KEY;
    delete process.env.OPENROUTER_RETRY_BASE_DELAY_MS;
    delete process.env.OPENROUTER_RETRY_MAX_DELAY_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("omits Anthropic thinking when the budget cannot fit", async () => {
    // MCQ uses a 1536-token budget: low (1024) leaves only 512, below the
    // 1024 minimum, so thinking is skipped and the output budget is intact.
    fetchQueue = [() => jsonResponse("{}")];

    const { generateAllMcqQuestions } = await import("../llm.js");
    await generateAllMcqQuestions("prompt", "", {
      override: {
        provider: "anthropic",
        transport: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKeys: ["sk-ant-test"],
        model: "claude-sonnet-4-5",
        effort: "low",
      },
    });

    const body = requestBody(0);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(1536);
  });

  it("reserves the output budget separately from Anthropic thinking", async () => {
    // Essay uses 8192 output tokens; high effort (8192, clamped to 7168 to
    // leave headroom) is added on top instead of starving the answer.
    fetchQueue = [() => streamResponse([anthropicSse("ok")])];

    const { generateGDocsChatStream } = await import("../llm.js");
    await generateGDocsChatStream([{ role: "user", content: "hi" }], "essay", {
      override: {
        provider: "anthropic",
        transport: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKeys: ["sk-ant-test"],
        model: "claude-sonnet-4-5",
        effort: "high",
      },
    });

    const body = requestBody(0);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 7168 });
    expect(body.max_tokens).toBe(8192 + 7168);
  });

  it("disables reasoning explicitly for router calls on OpenRouter", async () => {
    fetchQueue = [
      () =>
        jsonResponse('{"mode":"FAST","confidence":"high","reasoning":"t"}'),
    ];

    const { generateGDocsRoute } = await import("../llm.js");
    const result = await generateGDocsRoute("prompt", "", "", {
      override: {
        provider: "openrouter",
        transport: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeys: ["user-or-key"],
        model: "meta/muse-spark-1.3-contributor",
        effort: "high",
      },
    });

    expect(result.mode).toBe("FAST");
    // Explicit off switch — omitting the parameter would still think.
    expect(requestBody(0).reasoning).toEqual({ enabled: false });
    expect(requestBody(0).reasoning_effort).toBeUndefined();
  });

  it("disables reasoning for the tier-default router path", async () => {
    fetchQueue = [
      () =>
        jsonResponse('{"mode":"FAST","confidence":"high","reasoning":"t"}'),
    ];

    const { generateGDocsRoute } = await import("../llm.js");
    await generateGDocsRoute("prompt", "", "");

    expect(requestBody(0).reasoning).toEqual({ enabled: false });
  });

  it("maps reasoning-off to none for gpt-5 and low for o-series", async () => {
    fetchQueue = [
      () =>
        jsonResponse('{"mode":"FAST","confidence":"high","reasoning":"t"}'),
      () =>
        jsonResponse('{"mode":"FAST","confidence":"high","reasoning":"t"}'),
    ];

    const { generateGDocsRoute } = await import("../llm.js");
    const openaiOverride = (model: string) => ({
      provider: "openai" as const,
      transport: "openai-chat" as const,
      baseUrl: "https://api.openai.com/v1",
      apiKeys: ["sk-openai"],
      model,
      effort: "high" as const,
    });
    await generateGDocsRoute("prompt", "", "", {
      override: openaiOverride("gpt-5"),
    });
    await generateGDocsRoute("prompt", "", "", {
      override: openaiOverride("o3"),
    });

    expect(requestBody(0).reasoning_effort).toBe("none");
    expect(requestBody(1).reasoning_effort).toBe("low");
  });

  it("rotates override keys for MCQ generation", async () => {
    fetchQueue = [
      () => errorResponse(429, "rate limited"),
      () => errorResponse(429, "rate limited"),
      () =>
        jsonResponse(
          JSON.stringify([
            {
              question: "Q?",
              header: "H",
              options: [
                { label: "A", description: "d" },
                { label: "B", description: "e" },
              ],
            },
          ]),
        ),
    ];

    const { generateAllMcqQuestions } = await import("../llm.js");
    const questions = await generateAllMcqQuestions("prompt", "", {
      override: {
        provider: "oddity-free",
        transport: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeys: ["key1", "key2"],
        model: "some-model:free",
        effort: "default",
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(authHeader(0)).toBe("Bearer key1");
    expect(authHeader(1)).toBe("Bearer key1");
    expect(authHeader(2)).toBe("Bearer key2");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.question).toBe("Q?");
  });

  it("falls back to generic questions when MCQ retry plan exhausts", async () => {
    fetchQueue = [
      () => errorResponse(429, "rate limited"),
      () => errorResponse(429, "rate limited"),
    ];

    const { generateAllMcqQuestions } = await import("../llm.js");
    const questions = await generateAllMcqQuestions("prompt", "", {
      override: {
        provider: "oddity-free",
        transport: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeys: ["key1"],
        model: "some-model:free",
        effort: "default",
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0]?.question).toContain("main goal");
  });
});
