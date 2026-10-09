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

function validOverviewAnnotation(id: string, exact = "beta gamma") {
  return {
    id,
    mode: "overview",
    type: "core_claim",
    anchor: {
      type: "TextQuoteSelector",
      exact,
    },
    content: {
      note: `Summary ${id}`,
    },
  };
}

type FetchBody = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: string }>;
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

describe("generateAnnotationsStream", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("falls back to buffered generation when a stream parse error happens before output", async () => {
    // Two streaming attempts with malformed SSE, then a successful completion.
    fetchQueue = [
      () => streamResponse(["data: {not-json}\n\n"]),
      () => streamResponse(["data: {not-json}\n\n"]),
      () => jsonResponse(JSON.stringify([validOverviewAnnotation("fallback")])),
    ];

    const { generateAnnotationsStream } = await import("../openrouter.js");

    const seen: unknown[] = [];
    const result = await generateAnnotationsStream(
      "alpha beta gamma delta",
      "overview",
      undefined,
      {
        onAnnotation: (annotation) => {
          seen.push(annotation);
        },
        logContext: { route: "annotate/stream", requestId: "req_1" },
      },
    );

    expect(seen).toHaveLength(0);
    expect(result.usedBufferedFallback).toBe(true);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]!.anchor.exact).toBe("beta gamma");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("stops live stream retries after partial output and returns buffered fallback", async () => {
    const partial = sseData(
      JSON.stringify([validOverviewAnnotation("partial")]),
    );
    fetchQueue = [
      () => streamResponse([partial, "data: {not-json}\n\n"]),
      () =>
        jsonResponse(
          JSON.stringify([
            validOverviewAnnotation("full_1"),
            validOverviewAnnotation("full_2", "gamma delta"),
          ]),
        ),
    ];

    const { generateAnnotationsStream } = await import("../openrouter.js");

    const streamedIds: string[] = [];
    const result = await generateAnnotationsStream(
      "alpha beta gamma delta epsilon",
      "overview",
      undefined,
      {
        onAnnotation: (annotation) => {
          streamedIds.push(annotation.id);
        },
        logContext: { route: "annotate/stream", requestId: "req_2" },
      },
    );

    expect(streamedIds).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(requestBody(0).stream).toBe(true);
    expect(result.usedBufferedFallback).toBe(true);
    expect(result.annotations).toHaveLength(2);
  });

  it("rotates to the next key after retryable stream failures with no output", async () => {
    process.env.OPENROUTER_API_KEY_BACKUP1 = "key2";
    const success = sseData(
      JSON.stringify([validOverviewAnnotation("key2_success")]),
    );
    fetchQueue = [
      () => errorResponse(429, "rate limited"),
      () => errorResponse(429, "rate limited"),
      () => streamResponse([success, "data: [DONE]\n\n"]),
    ];

    const { generateAnnotationsStream } = await import("../openrouter.js");
    const result = await generateAnnotationsStream(
      "alpha beta gamma delta",
      "overview",
      undefined,
      { logContext: { route: "annotate/stream", requestId: "req_3" } },
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(authHeader(0)).toBe("Bearer key1");
    expect(authHeader(1)).toBe("Bearer key1");
    expect(authHeader(2)).toBe("Bearer key2");
    expect(result.usedBufferedFallback).toBe(false);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]!.anchor.exact).toBe("beta gamma");
  });

  it("surfaces upstream auth failures as permanent errors without retry", async () => {
    fetchQueue = [() => errorResponse(401, "invalid api key")];

    const { generateAnnotationsStream, LlmOperationError } = await import(
      "../openrouter.js"
    );

    await expect(
      generateAnnotationsStream("alpha beta gamma delta", "overview"),
    ).rejects.toBeInstanceOf(LlmOperationError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("generateSketchStream", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("includes provided user reactions in prompt mode", async () => {
    fetchQueue = [() => streamResponse([sseData("done"), "data: [DONE]\n\n"])];

    const { generateSketchStream } = await import("../openrouter.js");
    await generateSketchStream(
      "source text",
      "write a rebuttal",
      "User-written note\nNote: push harder on section 2",
      "prompt",
    );

    const body = requestBody(0);
    const userMessage = body.messages?.[1]?.content ?? "";

    expect(body.model).toBe("meta/muse-spark-1.3-contributor");
    expect(userMessage).toContain("User's Notes and Reactions:");
    expect(userMessage).toContain("push harder on section 2");
    expect(userMessage).not.toContain(
      "Do not infer, invent, or attribute any opinions",
    );
  });

  it("adds a strict non-invention guard when prompt mode has no user reactions", async () => {
    fetchQueue = [() => streamResponse([sseData("done"), "data: [DONE]\n\n"])];

    const { generateSketchStream } = await import("../openrouter.js");
    await generateSketchStream(
      "source text",
      "draft a message to my team",
      "",
      "prompt",
    );

    const body = requestBody(0);
    const userMessage = body.messages?.[1]?.content ?? "";

    expect(userMessage).toContain("No user notes or reactions were provided.");
    expect(userMessage).toContain(
      "Do not infer, invent, or attribute any opinions",
    );
    expect(userMessage).toContain(
      "Ground the result only in the source text and the stated purpose.",
    );
    expect(userMessage).not.toContain("User's Notes and Reactions:");
  });

  it("uses conservative framing when sketch mode has no user reactions", async () => {
    fetchQueue = [() => streamResponse([sseData("done"), "data: [DONE]\n\n"])];

    const { generateSketchStream } = await import("../openrouter.js");
    await generateSketchStream(
      "source text",
      "understand the argument better",
      "   ",
      "sketch",
    );

    const body = requestBody(0);
    const userMessage = body.messages?.[1]?.content ?? "";

    expect(userMessage).toContain("Purpose of Reading:");
    expect(userMessage).toContain("No user notes or reactions were provided.");
    expect(userMessage).toContain(
      "Only include positions that are directly supported by the stated purpose",
    );
    expect(userMessage).not.toContain("User's Reactions:");
  });
});
