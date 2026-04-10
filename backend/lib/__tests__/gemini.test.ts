import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamChunk = { text: () => string };
type StreamFactory = () => Promise<{
  stream: AsyncIterable<StreamChunk>;
  response: Promise<unknown>;
}>;
type ContentFactory = () => Promise<{ response: { text: () => string } }>;

type MockBehavior = {
  streamFactories: StreamFactory[];
  contentFactories: ContentFactory[];
  streamSpy: ReturnType<typeof vi.fn>;
  contentSpy: ReturnType<typeof vi.fn>;
};

const behaviors = new Map<string, MockBehavior>();

class MockGoogleGenerativeAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleGenerativeAIError";
  }
}

class MockGoogleGenerativeAIFetchError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GoogleGenerativeAIFetchError";
    this.status = status;
  }
}

class MockGoogleGenerativeAI {
  constructor(private readonly key: string) {}

  getGenerativeModel() {
    const behavior = behaviors.get(this.key);
    if (!behavior) {
      throw new Error(`Missing mock behavior for key ${this.key}`);
    }

    behavior.streamSpy.mockImplementation(async () => {
      const factory = behavior.streamFactories.shift();
      if (!factory) {
        throw new Error(`No stream factory left for key ${this.key}`);
      }
      return factory();
    });

    behavior.contentSpy.mockImplementation(async () => {
      const factory = behavior.contentFactories.shift();
      if (!factory) {
        throw new Error(`No content factory left for key ${this.key}`);
      }
      return factory();
    });

    return {
      generateContentStream: behavior.streamSpy,
      generateContent: behavior.contentSpy,
    };
  }
}

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
  GoogleGenerativeAIError: MockGoogleGenerativeAIError,
  GoogleGenerativeAIFetchError: MockGoogleGenerativeAIFetchError,
}));

function setBehavior(
  key: string,
  config: {
    streamFactories?: StreamFactory[];
    contentFactories?: ContentFactory[];
  },
): MockBehavior {
  const behavior: MockBehavior = {
    streamFactories: [...(config.streamFactories ?? [])],
    contentFactories: [...(config.contentFactories ?? [])],
    streamSpy: vi.fn(),
    contentSpy: vi.fn(),
  };
  behaviors.set(key, behavior);
  return behavior;
}

function createStream(
  chunks: string[],
  terminalError?: Error,
): AsyncIterable<StreamChunk> {
  return (async function* streamGenerator() {
    for (const chunk of chunks) {
      yield { text: () => chunk };
    }

    if (terminalError) {
      throw terminalError;
    }
  })();
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

describe("generateAnnotationsStream", () => {
  beforeEach(() => {
    vi.resetModules();
    behaviors.clear();
    process.env.NODE_ENV = "test";
    process.env.GEMINI_API_KEY = "key1";
    delete process.env.GEMINI_API_KEY_BACKUP1;
    delete process.env.GEMINI_API_KEY_BACKUP2;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to buffered generation when a stream parse error happens before output", async () => {
    const parseError = new MockGoogleGenerativeAIError(
      "[GoogleGenerativeAI Error]: Failed to parse stream",
    );

    setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream([], parseError),
          response: Promise.reject(parseError),
        }),
        async () => ({
          stream: createStream([], parseError),
          response: Promise.reject(parseError),
        }),
      ],
      contentFactories: [
        async () => ({
          response: {
            text: () => JSON.stringify([validOverviewAnnotation("fallback")]),
          },
        }),
      ],
    });

    const { generateAnnotationsStream } = await import("../gemini.js");

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
  });

  it("stops live stream retries after partial output and returns buffered fallback", async () => {
    const parseError = new MockGoogleGenerativeAIError(
      "[GoogleGenerativeAI Error]: Failed to parse stream",
    );

    const key1 = setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream(
            [JSON.stringify([validOverviewAnnotation("partial")])],
            parseError,
          ),
          response: Promise.reject(parseError),
        }),
      ],
      contentFactories: [
        async () => ({
          response: {
            text: () =>
              JSON.stringify([
                validOverviewAnnotation("full_1"),
                validOverviewAnnotation("full_2", "gamma delta"),
              ]),
          },
        }),
      ],
    });

    const { generateAnnotationsStream } = await import("../gemini.js");

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
    expect(key1.streamSpy).toHaveBeenCalledTimes(1);
    expect(result.usedBufferedFallback).toBe(true);
    expect(result.annotations).toHaveLength(2);
  });

  it("rotates to the next key after retryable stream failures with no output", async () => {
    const parseError = new MockGoogleGenerativeAIError(
      "[GoogleGenerativeAI Error]: Failed to parse stream",
    );

    const key1 = setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream([], parseError),
          response: Promise.reject(parseError),
        }),
        async () => ({
          stream: createStream([], parseError),
          response: Promise.reject(parseError),
        }),
      ],
    });
    process.env.GEMINI_API_KEY_BACKUP1 = "key2";
    const key2 = setBehavior("key2", {
      streamFactories: [
        async () => ({
          stream: createStream([
            JSON.stringify([validOverviewAnnotation("key2_success")]),
          ]),
          response: Promise.resolve({}),
        }),
      ],
    });

    const { generateAnnotationsStream } = await import("../gemini.js");
    const result = await generateAnnotationsStream(
      "alpha beta gamma delta",
      "overview",
      undefined,
      { logContext: { route: "annotate/stream", requestId: "req_3" } },
    );

    expect(key1.streamSpy).toHaveBeenCalledTimes(2);
    expect(key2.streamSpy).toHaveBeenCalledTimes(1);
    expect(result.usedBufferedFallback).toBe(false);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]!.anchor.exact).toBe("beta gamma");
  });
});

describe("generateSketchStream", () => {
  beforeEach(() => {
    vi.resetModules();
    behaviors.clear();
    process.env.NODE_ENV = "test";
    process.env.GEMINI_API_KEY = "key1";
    delete process.env.GEMINI_API_KEY_BACKUP1;
    delete process.env.GEMINI_API_KEY_BACKUP2;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes provided user reactions in prompt mode", async () => {
    const key1 = setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream(["done"]),
          response: Promise.resolve({}),
        }),
      ],
    });

    const { generateSketchStream } = await import("../gemini.js");
    await generateSketchStream(
      "source text",
      "write a rebuttal",
      "User-written note\nNote: push harder on section 2",
      "prompt",
    );

    const request = key1.streamSpy.mock.calls[0]?.[0] as
      | { contents?: Array<{ parts?: Array<{ text?: string }> }> }
      | undefined;
    const userMessage = request?.contents?.[0]?.parts?.[0]?.text ?? "";

    expect(userMessage).toContain("User's Notes and Reactions:");
    expect(userMessage).toContain("push harder on section 2");
    expect(userMessage).not.toContain("Do not infer, invent, or attribute any opinions");
  });

  it("adds a strict non-invention guard when prompt mode has no user reactions", async () => {
    const key1 = setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream(["done"]),
          response: Promise.resolve({}),
        }),
      ],
    });

    const { generateSketchStream } = await import("../gemini.js");
    await generateSketchStream(
      "source text",
      "draft a message to my team",
      "",
      "prompt",
    );

    const request = key1.streamSpy.mock.calls[0]?.[0] as
      | { contents?: Array<{ parts?: Array<{ text?: string }> }> }
      | undefined;
    const userMessage = request?.contents?.[0]?.parts?.[0]?.text ?? "";

    expect(userMessage).toContain("No user notes or reactions were provided.");
    expect(userMessage).toContain("Do not infer, invent, or attribute any opinions");
    expect(userMessage).toContain("Ground the result only in the source text and the stated purpose.");
    expect(userMessage).not.toContain("User's Notes and Reactions:");
  });

  it("uses conservative framing when sketch mode has no user reactions", async () => {
    const key1 = setBehavior("key1", {
      streamFactories: [
        async () => ({
          stream: createStream(["done"]),
          response: Promise.resolve({}),
        }),
      ],
    });

    const { generateSketchStream } = await import("../gemini.js");
    await generateSketchStream(
      "source text",
      "understand the argument better",
      "   ",
      "sketch",
    );

    const request = key1.streamSpy.mock.calls[0]?.[0] as
      | { contents?: Array<{ parts?: Array<{ text?: string }> }> }
      | undefined;
    const userMessage = request?.contents?.[0]?.parts?.[0]?.text ?? "";

    expect(userMessage).toContain("Purpose of Reading:");
    expect(userMessage).toContain("No user notes or reactions were provided.");
    expect(userMessage).toContain("Only include positions that are directly supported by the stated purpose");
    expect(userMessage).not.toContain("User's Reactions:");
  });
});
